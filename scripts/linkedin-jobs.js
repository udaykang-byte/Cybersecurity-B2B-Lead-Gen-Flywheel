#!/usr/bin/env node

/**
 * LinkedIn Jobs Signal Scanner
 *
 * Searches LinkedIn job postings for cybersecurity hiring signals using Apify.
 * Extracts competitor tools, compliance frameworks, and pain language from job
 * descriptions, then scores and prioritizes leads using the Intent Signals Playbook.
 *
 * Usage:
 *   node Skills/linkedin-jobs.js <url1> [url2] [options]
 *
 * Options:
 *   --topic <Name>          Topic directory for output (default: "LinkedIn")
 *   --count <N>             Max results per search URL (default: 25)
 *   --since <duration>      Only include results from last N days (e.g., 7d, 30d)
 *   --score-threshold <N>   Only output signals scoring >= N (default: 0)
 *   --dry-run               Print URLs and actor info without calling Apify
 *
 * Examples:
 *   node Skills/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=IAM&geoId=103644278&f_TPR=r86400" --topic IdentityManagement
 *   node Skills/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=CISO" --count 50 --dry-run
 *
 * Environment:
 *   Requires APIFY_API_TOKEN in .env
 *
 * Output:
 *   <Topic>/LinkedIn/jobs-<timestamp>.json
 *   <Topic>/LinkedIn/jobs-<timestamp>.md
 *   linkedin-history.jsonl (audit log)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './lib/supabase.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Load .env ──
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const [key, ...valueParts] = line.split('=');
            if (key && valueParts.length) {
                process.env[key.trim()] = valueParts.join('=').trim();
            }
        });
    }
} catch (e) {
    // .env not found, continue
}

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

// ── Apify Actor ──
const ACTOR_ID = 'curious_coder~linkedin-jobs-scraper';
const ACTOR_URL = 'https://apify.com/curious_coder/linkedin-jobs-scraper';


// ── Competitor Tools (technographic signals) ──
const COMPETITOR_TOOLS = [
    // Core IAM/SSO
    'okta', 'sailpoint', 'cyberark', 'beyondtrust', 'delinea',
    'ping identity', 'onelogin', 'saviynt', 'forgerock', 'auth0',
    'vanta', 'drata', 'secureauth', 'centrify', 'thales',
    'microsoft entra', 'azure ad', 'active directory',
    // Legacy/international PAM vendors
    'thycotic', 'wallix', 'senhasegura', 'arcon', 'krontech',
    // IGA tools
    'oracle identity', 'ibm isim', 'ibm igm', 'quest one identity', 'omada identity',
    // Secrets management (DevOps PAM)
    'hashicorp vault', 'conjur', 'akeyless', 'doppler', 'infisical',
    // CIEM / cloud entitlement
    'ermetic', 'sonrai security'
];

// ── Compliance Frameworks ──
const FRAMEWORK_KEYWORDS = [
    'soc 2', 'soc2', 'iso 27001', 'hipaa', 'cmmc', 'nist',
    'pci dss', 'pci-dss', 'fedramp', 'gdpr', 'ccpa', 'sox',
    'nist 800-53', 'nist csf', 'cis controls', 'cobit',
    // Additional frameworks
    'nerc cip', 'rbi', 'sebi', 'nist 800-207', 'nist sp 800-63',
    'iec 62443', 'tisax', 'fisma', 'itar', 'swift cscf'
];

// ── Pain Language ──
const PAIN_KEYWORDS = [
    'manual', 'manual processes', 'lack of visibility', 'access sprawl',
    'identity sprawl', 'no automation', 'spreadsheet', 'legacy',
    'technical debt', 'audit findings', 'audit requirements',
    'security gap', 'compliance gap', 'too many accounts',
    'offboarding', 'orphaned accounts', 'access reviews',
    'rubber stamping', 'over-provisioned',
    // PAM-specific pain
    'unmanaged service accounts', 'shared credentials', 'shared admin accounts',
    'no visibility into privileged', 'privileged account sprawl', 'admin account sprawl',
    'hardcoded credentials', 'hardcoded passwords', 'excessive privileges',
    'standing privileges', 'standing access', 'lateral movement risk',
    'credential theft', 'insider threat', 'third-party vendor risk',
    'vendor access uncontrolled', 'no audit trail', 'manual access reviews',
    'access recertification', 'certification campaign',
    // Cloud identity pain
    'cloud entitlement', 'entitlement sprawl', 'shadow it access',
    // Zero trust journey
    'zero trust initiative', 'zero trust roadmap', 'implementing zero trust',
    // OT/ICS pain
    'ot security gap', 'ics access control'
];

// ── Scoring Rules (from Intent Signals Playbook /50 system) ──
const SCORING_RULES = {
    'hiring-ciso':          { base: 35, urgency: 'High',     window: '3-day' },
    'hiring-iam-engineer':  { base: 25, urgency: 'Medium',   window: 'next batch' },
    'hiring-grc-analyst':   { base: 25, urgency: 'Medium',   window: 'next batch' },
    'hiring-pam-engineer':  { base: 25, urgency: 'Medium',   window: 'next batch' },
    'hiring-security-role': { base: 22, urgency: 'Medium',   window: 'next batch' },
    'hiring-other':         { base: 5,  urgency: 'Low',      window: 'backlog' },

    bonuses: {
        competitorToolInJD:      5,
        multiplePostings:        5,
        complianceFrameworkCited: 3,
        painLanguageDetected:    2,
        vantaDrataDetected:      3
    }
};

// ── Signal Stack Rules ──
const STACK_RULES = [
    {
        id: 'ciso-plus-iam-hire',
        description: 'Hiring CISO + IAM engineer simultaneously',
        match: (signals) => signals.some(s => s.type === 'hiring-ciso') && signals.some(s => s.type.includes('iam')),
        score: 42,
        bonusCondition: 'competitorToolInJD',
        bonusPoints: 5,
        urgency: 'Critical',
        window: '24hr'
    },
    {
        id: 'soc2-plus-compliance-hire',
        description: 'SOC 2 in JD + hiring compliance role',
        match: (signals) => signals.some(s => s.frameworks.includes('soc 2') || s.frameworks.includes('soc2')) && signals.some(s => s.type.includes('grc')),
        score: 40,
        bonusCondition: 'vantaDrataDetected',
        bonusPoints: 3,
        urgency: 'Critical',
        window: '48hr'
    },
    {
        id: 'competitor-multiple-postings',
        description: 'Competitor tool + multiple job postings',
        match: (signals) => signals.filter(s => s.currentTools.length > 0).length >= 2,
        score: 37,
        urgency: 'High',
        window: 'week 1'
    }
];

// ── Outreach Templates (from playbook signal-to-message mapping) ──
const OUTREACH_TEMPLATES = {
    'hiring-iam-engineer': {
        angle: 'IAM modernization',
        opener: 'Most companies hiring for this role run into integration complexity during implementation. We help teams get past the setup phase and into production faster.',
        cta: 'Worth a 15-min call before you spec the project?'
    },
    'hiring-grc-analyst': {
        angle: 'Compliance gap',
        opener: 'Compliance platforms like Vanta/Drata tell you what controls you need — but you still need to implement the identity and access controls behind them.',
        cta: 'Can share what other companies in your space got dinged on.'
    },
    'hiring-pam-engineer': {
        angle: 'PAM implementation',
        opener: 'Privileged access management projects often stall when teams underestimate the integration scope with existing identity infrastructure.',
        cta: 'Happy to share a PAM readiness checklist.'
    },
    'hiring-ciso': {
        angle: 'CISO 90-day priorities',
        opener: 'Most CISOs spend their first 90 days auditing privileged access and identity governance. We help new security leaders accelerate that assessment.',
        cta: 'Happy to share what we\'re seeing across the space.'
    },
    'hiring-security-role': {
        angle: 'Security program build-out',
        opener: 'Building out a security function often means inheriting identity and access debt that\'s been accumulating for years.',
        cta: 'Worth connecting to compare notes?'
    },
    'competitor-displacement': {
        angle: 'Competitive displacement',
        opener: 'Most teams at your stage run into known limitations with {tool}. We help organizations navigate that transition.',
        cta: 'Worth comparing approaches?'
    }
};

// ── HTTP Helper ──
function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: data });
                }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ── Apify Helpers ──
async function startActorRun(searchUrls, count) {
    const effectiveCount = Math.max(count, 10); // actor minimum is 10
    const body = {
        count: effectiveCount,
        scrapeCompany: true,
        splitByLocation: false,
        urls: searchUrls,
    };

    const postData = JSON.stringify(body);

    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/acts/${ACTOR_ID}/runs?maxItems=${effectiveCount * searchUrls.length}`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${APIFY_TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const maxRetries = 3;
    const backoffDelays = [2000, 8000, 32000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const response = await makeRequest(options, postData);

        if (response.status === 201) {
            return response.data;
        }

        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries - 1) {
            const delay = backoffDelays[attempt];
            console.log(`  API returned ${response.status}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
        }

        throw new Error(`Failed to start actor run: HTTP ${response.status}\n  Response: ${JSON.stringify(response.data)}\n  Actor: ${ACTOR_URL}`);
    }
}

async function waitForCompletion(runId, label = '') {
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/actor-runs/${runId}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    };

    let attempts = 0;
    const maxAttempts = 60;

    while (attempts < maxAttempts) {
        const response = await makeRequest(options);
        const status = response.data?.data?.status;

        process.stdout.write(`\r${label}  Status: ${status} (${attempts + 1}/${maxAttempts})`);

        if (status === 'SUCCEEDED') {
            process.stdout.write('\n');
            return response.data.data;
        }

        if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
            process.stdout.write('\n');
            const msg = response.data?.data?.statusMessage || 'No details';
            throw new Error(`Actor run ${status}: ${msg}\n  Check: https://console.apify.com/actors/runs/${runId}`);
        }

        const delay = Math.min(3000 * Math.pow(1.3, attempts), 15000);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
    }

    throw new Error('Timeout waiting for actor run to complete');
}

async function getResults(datasetId) {
    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/datasets/${datasetId}/items`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${APIFY_TOKEN}` }
    };

    const response = await makeRequest(options);
    return Array.isArray(response.data) ? response.data : [];
}

// ── Signal Extraction ──
function detectCompetitorTools(text) {
    const lower = text.toLowerCase();
    return COMPETITOR_TOOLS.filter(tool => lower.includes(tool));
}

function detectFrameworks(text) {
    const lower = text.toLowerCase();
    return FRAMEWORK_KEYWORDS.filter(fw => lower.includes(fw));
}

function detectPainLanguage(text) {
    const lower = text.toLowerCase();
    return PAIN_KEYWORDS.filter(pain => lower.includes(pain));
}

function segmentCompany(employeeCount) {
    if (!employeeCount || employeeCount <= 0) return 'Unknown';
    if (employeeCount >= 1000) return 'A';
    if (employeeCount >= 100) return 'B';
    return 'C';
}

function classifySignalType(title, description) {
    const titleLower = (title || '').toLowerCase();
    const descLower = (description || '').toLowerCase();

    // Check title first (most reliable signal)
    if (/\b(ciso|chief information security officer)\b/.test(titleLower) ||
        /\b(vp|vice president).*(?:information|cyber).*security\b/.test(titleLower) ||
        /\bhead of (?:cyber|information) ?security\b/.test(titleLower)) {
        return 'hiring-ciso';
    }
    if (/\b(iam|identity.*access|identity.*governance|iga)\b/.test(titleLower)) {
        return 'hiring-iam-engineer';
    }
    if (/\b(grc|governance.*risk.*compliance|compliance.*(?:analyst|manager|officer))\b/.test(titleLower)) {
        return 'hiring-grc-analyst';
    }
    if (/\b(pam|privileged.*access|cyberark|beyondtrust|delinea)\b/.test(titleLower)) {
        return 'hiring-pam-engineer';
    }
    if (/\b(security.*(?:engineer|architect|analyst|manager)|infosec)\b/.test(titleLower)) {
        return 'hiring-security-role';
    }

    // Fall back to description (only for strong matches)
    if (/\b(ciso|chief information security officer)\b/.test(descLower)) {
        return 'hiring-ciso';
    }
    if (/\b(iam|identity access management|identity governance|iga)\b/.test(descLower)) {
        return 'hiring-iam-engineer';
    }
    if (/\b(grc|governance risk compliance)\b/.test(descLower)) {
        return 'hiring-grc-analyst';
    }
    if (/\b(privileged access management)\b/.test(descLower)) {
        return 'hiring-pam-engineer';
    }
    if (/\b(security engineer|security architect|infosec)\b/.test(descLower)) {
        return 'hiring-security-role';
    }

    // No clear security/IAM signal — generic role
    return 'hiring-other';
}

// ── Description Summarizer ──
function summarizeDescription(description) {
    if (!description) return { summary: '', keyRequirements: [], responsibilities: [] };

    const text = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Extract key requirements (skills, tools, certifications, experience)
    const reqPatterns = [
        /(\d+\+?\s*years?\s+(?:of\s+)?experience\s+(?:in\s+|with\s+)?[^.;,]{5,60})/gi,
        /((?:proficiency|expertise|experience|knowledge|familiarity)\s+(?:in|with)\s+[^.;]{5,80})/gi,
        /((?:bachelor|master|degree|certification|certified|cissp|cisa|cism|ccsp|comptia|sans|giac)[^.;]{5,80})/gi,
        /((?:must have|required|minimum|essential)[:]\s*[^.;]{5,100})/gi
    ];

    const keyRequirements = [];
    for (const pattern of reqPatterns) {
        const matches = text.match(pattern) || [];
        for (const m of matches) {
            const cleaned = m.trim().replace(/^[-•·]\s*/, '');
            if (cleaned.length > 10 && cleaned.length < 150 && !keyRequirements.some(r => r.toLowerCase() === cleaned.toLowerCase())) {
                keyRequirements.push(cleaned);
            }
        }
    }

    // Extract key responsibilities
    const respPatterns = [
        /((?:manage|lead|oversee|develop|implement|design|architect|drive|build|establish|define|maintain)\s+[^.;]{10,100})/gi
    ];

    const responsibilities = [];
    for (const pattern of respPatterns) {
        const matches = text.match(pattern) || [];
        for (const m of matches) {
            const cleaned = m.trim().replace(/^[-•·]\s*/, '');
            if (cleaned.length > 15 && cleaned.length < 150 && !responsibilities.some(r => r.toLowerCase() === cleaned.toLowerCase())) {
                responsibilities.push(cleaned);
            }
        }
    }

    // Build a concise summary: first 2-3 meaningful sentences
    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.length > 20 && s.length < 300);
    // Skip boilerplate (equal opportunity, apply now, etc.)
    const boilerplate = /equal opportunity|we are an|apply now|click here|eoe|affirmative action|reasonable accommodation|we do not discriminate/i;
    const meaningful = sentences.filter(s => !boilerplate.test(s));
    const summary = meaningful.slice(0, 3).join(' ');

    return {
        summary: summary.slice(0, 500),
        keyRequirements: keyRequirements.slice(0, 5),
        responsibilities: responsibilities.slice(0, 5)
    };
}

function extractJobSignals(jobResults) {
    const signals = [];

    for (const job of jobResults) {
        const title = job.title || job.jobTitle || '';
        const description = job.descriptionText || job.description || job.jobDescription || '';
        const company = job.companyName || job.company || '';
        const companyUrl = job.companyLinkedinUrl || job.companyUrl || job.companyLink || '';
        const location = job.location || job.jobLocation || '';
        const employeeCount = job.companyEmployeesCount || job.employeeCount || job.companySize || 0;
        const url = job.link || job.url || job.jobUrl || '';
        const postedAt = job.postedAt || job.publishedAt || job.datePosted || job.postedDate || '';
        const seniorityLevel = job.seniorityLevel || '';
        const employmentType = job.employmentType || '';
        const industries = job.industries || '';
        const applicantsCount = job.applicantsCount || '';
        const salary = job.salary || '';
        const companyDescription = job.companyDescription || '';
        const companyWebsite = job.companyWebsite || '';

        const fullText = title + ' ' + description;
        const currentTools = detectCompetitorTools(fullText);
        const frameworks = detectFrameworks(fullText);
        const painLanguage = detectPainLanguage(fullText);
        const type = classifySignalType(title, description);
        const descSummary = summarizeDescription(description);

        let headcountClue = '';
        const headcountMatch = fullText.match(/(\d+)\s*(?:to|[-–])\s*(\d+)\s*(?:employees|people|team|person)/i);
        if (headcountMatch) {
            headcountClue = headcountMatch[0];
        }
        const growthMatch = fullText.match(/(rapidly growing|fast[- ]growing|scaling|expanding|first.*hire|building.*team)/i);
        if (growthMatch && !headcountClue) {
            headcountClue = growthMatch[0];
        }

        const empCount = typeof employeeCount === 'number' ? employeeCount : parseInt(employeeCount) || 0;

        signals.push({
            id: `li-job-${signals.length + 1}`,
            source: 'linkedin-jobs',
            category: type.includes('iam') ? 'iam' : type.includes('grc') ? 'grc' : type.includes('pam') ? 'pam' : type.includes('ciso') ? 'ciso' : type === 'hiring-other' ? 'other' : 'security',
            type,
            company,
            companyUrl: normalizeCompanyUrl(companyUrl),
            companyWebsite,
            companySize: empCount,
            segment: segmentCompany(empCount),
            industries,
            title,
            seniorityLevel,
            employmentType,
            location,
            salary,
            applicantsCount,
            url,
            postedAt,
            detectedAt: new Date().toISOString(),
            currentTools,
            frameworks,
            painLanguage,
            headcountClue,
            descriptionSummary: descSummary.summary,
            keyRequirements: descSummary.keyRequirements,
            keyResponsibilities: descSummary.responsibilities,
            companyDescription: companyDescription.slice(0, 300),
            baseScore: 0,
            bonuses: [],
            totalScore: 0,
            urgency: '',
            urgencyWindow: '',
            outreachAngle: '',
            suggestedMessage: ''
        });
    }

    return signals;
}

function normalizeCompanyUrl(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const pathParts = u.pathname.split('/').filter(Boolean);
        if (pathParts[0] === 'company' && pathParts[1]) {
            return `https://www.linkedin.com/company/${pathParts[1]}`;
        }
    } catch { /* return as-is */ }
    return url;
}

// ── Scoring ──
function scoreSignal(signal) {
    const rule = SCORING_RULES[signal.type] || SCORING_RULES['hiring-security-role'];
    signal.baseScore = rule.base;
    signal.urgency = rule.urgency;
    signal.urgencyWindow = rule.window;
    signal.bonuses = [];

    if (signal.currentTools.length > 0) {
        signal.bonuses.push({ reason: 'competitor tool in JD', points: SCORING_RULES.bonuses.competitorToolInJD });
    }
    if (signal.frameworks.length > 0) {
        signal.bonuses.push({ reason: 'compliance framework cited', points: SCORING_RULES.bonuses.complianceFrameworkCited });
    }
    if (signal.painLanguage.length > 0) {
        signal.bonuses.push({ reason: 'pain language detected', points: SCORING_RULES.bonuses.painLanguageDetected });
    }
    const hasVantaDrata = signal.currentTools.some(t => t === 'vanta' || t === 'drata');
    if (hasVantaDrata) {
        signal.bonuses.push({ reason: 'Vanta/Drata detected', points: SCORING_RULES.bonuses.vantaDrataDetected });
    }

    signal.totalScore = signal.baseScore + signal.bonuses.reduce((sum, b) => sum + b.points, 0);
    if (signal.totalScore > 50) signal.totalScore = 50;

    return signal;
}

function detectSignalStacks(signals) {
    const byCompany = {};
    for (const s of signals) {
        const key = (s.companyUrl || s.company || '').toLowerCase();
        if (!key) continue;
        if (!byCompany[key]) byCompany[key] = [];
        byCompany[key].push(s);
    }

    const stacks = [];
    for (const [companyKey, companySignals] of Object.entries(byCompany)) {
        if (companySignals.length < 2) continue;

        for (const rule of STACK_RULES) {
            if (rule.match(companySignals)) {
                let stackScore = rule.score;

                if (rule.bonusCondition && rule.bonusPoints) {
                    const hasBonus = companySignals.some(s => {
                        if (rule.bonusCondition === 'competitorToolInJD') return s.currentTools.length > 0;
                        if (rule.bonusCondition === 'vantaDrataDetected') return s.currentTools.some(t => t === 'vanta' || t === 'drata');
                        return false;
                    });
                    if (hasBonus) stackScore += rule.bonusPoints;
                }

                if (stackScore > 50) stackScore = 50;

                stacks.push({
                    company: companySignals[0].company,
                    companyUrl: companySignals[0].companyUrl,
                    signalIds: companySignals.map(s => s.id),
                    stackType: rule.id,
                    description: rule.description,
                    combinedScore: stackScore,
                    urgency: rule.urgency,
                    urgencyWindow: rule.window
                });

                for (const s of companySignals) {
                    if (stackScore > s.totalScore) {
                        s.totalScore = stackScore;
                        s.urgency = rule.urgency;
                        s.urgencyWindow = rule.window;
                        s.bonuses.push({ reason: `stacked: ${rule.description}`, points: stackScore - s.baseScore });
                    }
                }

                break;
            }
        }

        if (companySignals.length >= 2 && !stacks.some(st => st.companyUrl === companySignals[0].companyUrl)) {
            for (const s of companySignals) {
                s.bonuses.push({ reason: 'multiple postings from same company', points: SCORING_RULES.bonuses.multiplePostings });
                s.totalScore += SCORING_RULES.bonuses.multiplePostings;
                if (s.totalScore > 50) s.totalScore = 50;
            }
        }
    }

    return stacks;
}

// ── Outreach Mapping ──
function mapSignalToOutreach(signal) {
    if (signal.currentTools.length > 0) {
        const topTool = signal.currentTools[0];
        signal.outreachAngle = 'Competitive displacement';
        signal.suggestedMessage = OUTREACH_TEMPLATES['competitor-displacement'].opener.replace('{tool}', topTool)
            + ' ' + OUTREACH_TEMPLATES['competitor-displacement'].cta;
        return;
    }

    const template = OUTREACH_TEMPLATES[signal.type] || OUTREACH_TEMPLATES['hiring-security-role'];
    signal.outreachAngle = template.angle;
    signal.suggestedMessage = template.opener + ' ' + template.cta;
}

// ── Deduplication ──
function loadSeenUrls(topic) {
    const seenFile = topic ? path.join(topic, 'LinkedIn', '.seen-urls.json') : null;
    if (!seenFile) return { seen: new Set(), file: null };
    try {
        const existing = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
        return { seen: new Set(existing), file: seenFile };
    } catch {
        return { seen: new Set(), file: seenFile };
    }
}

function saveSeenUrls(seenSet, seenFile) {
    if (!seenFile) return;
    const dir = path.dirname(seenFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(seenFile, JSON.stringify([...seenSet], null, 2));
}

// ── Output Generation ──
function buildOutputJSON(signals, stacks, meta) {
    const byUrgency = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    const bySegment = { A: 0, B: 0, C: 0, Unknown: 0 };

    for (const s of signals) {
        byUrgency[s.urgency] = (byUrgency[s.urgency] || 0) + 1;
        bySegment[s.segment] = (bySegment[s.segment] || 0) + 1;
    }

    return {
        meta: {
            ...meta,
            signalsExtracted: signals.length,
            stacks: stacks.length,
            byUrgency,
            bySegment
        },
        signals: signals.sort((a, b) => b.totalScore - a.totalScore),
        stacks
    };
}

function generateMarkdownReport(signals, stacks, meta) {
    const lines = [];
    const date = new Date().toISOString().split('T')[0];

    lines.push(`# LinkedIn Jobs — Signal Report (${date})`);
    lines.push('');
    lines.push(`**Topic:** ${meta.topic} | **URLs searched:** ${meta.urlCount} | **Total results:** ${meta.totalResults}`);
    lines.push(`**Signals found:** ${signals.length} | **Signal stacks:** ${stacks.length}`);
    lines.push('');

    const byUrgency = { Critical: [], High: [], Medium: [], Low: [] };
    for (const s of signals) {
        if (byUrgency[s.urgency]) byUrgency[s.urgency].push(s);
        else byUrgency.Medium.push(s);
    }

    lines.push('## Summary');
    lines.push('');
    lines.push(`| Urgency | Count | Action Window |`);
    lines.push(`|---------|-------|--------------|`);
    if (byUrgency.Critical.length > 0) lines.push(`| **CRITICAL** | ${byUrgency.Critical.length} | 24-48 hours |`);
    if (byUrgency.High.length > 0) lines.push(`| **HIGH** | ${byUrgency.High.length} | 3 days - 1 week |`);
    if (byUrgency.Medium.length > 0) lines.push(`| **MEDIUM** | ${byUrgency.Medium.length} | Next batch |`);
    if (byUrgency.Low.length > 0) lines.push(`| **LOW** | ${byUrgency.Low.length} | Backlog (likely not relevant) |`);
    lines.push('');

    if (stacks.length > 0) {
        lines.push('## Signal Stacks (Multi-Signal Companies)');
        lines.push('');
        for (const stack of stacks) {
            lines.push(`### ${stack.company} — ${stack.urgency} (Score: ${stack.combinedScore}/50)`);
            lines.push(`**Stack:** ${stack.description}`);
            lines.push(`**Action window:** ${stack.urgencyWindow}`);
            lines.push('');
        }
    }

    for (const [urgencyLevel, urgencySignals] of Object.entries(byUrgency)) {
        if (urgencySignals.length === 0) continue;

        lines.push(`## ${urgencyLevel} Signals`);
        lines.push('');

        for (const s of urgencySignals.sort((a, b) => b.totalScore - a.totalScore)) {
            lines.push(`### ${s.company || 'Unknown Company'} — ${s.title}`);
            lines.push(`**Score:** ${s.totalScore}/50 | **Segment:** ${s.segment} (${s.companySize || '?'} employees) | **Window:** ${s.urgencyWindow}`);
            if (s.location) lines.push(`**Location:** ${s.location}`);
            if (s.seniorityLevel || s.employmentType) lines.push(`**Level:** ${[s.seniorityLevel, s.employmentType].filter(Boolean).join(' | ')}`);
            if (s.salary) lines.push(`**Salary:** ${s.salary}`);
            if (s.industries) lines.push(`**Industry:** ${s.industries}`);
            if (s.applicantsCount) lines.push(`**Applicants:** ${s.applicantsCount}`);
            if (s.companyUrl) lines.push(`**Company:** ${s.companyUrl}`);
            if (s.companyWebsite) lines.push(`**Website:** ${s.companyWebsite}`);
            if (s.url) lines.push(`**Job posting:** ${s.url}`);
            lines.push('');

            if (s.currentTools.length > 0) {
                lines.push(`**Competitor tools detected:** ${s.currentTools.join(', ')}`);
            }
            if (s.frameworks.length > 0) {
                lines.push(`**Compliance frameworks:** ${s.frameworks.join(', ')}`);
            }
            if (s.painLanguage.length > 0) {
                lines.push(`**Pain language:** ${s.painLanguage.join(', ')}`);
            }
            if (s.headcountClue) {
                lines.push(`**Headcount clue:** ${s.headcountClue}`);
            }

            if (s.bonuses.length > 0) {
                lines.push(`**Score bonuses:** ${s.bonuses.map(b => `+${b.points} (${b.reason})`).join(', ')}`);
            }

            // Job description summary
            if (s.descriptionSummary) {
                lines.push('');
                lines.push(`**Job Summary:** ${s.descriptionSummary}`);
            }
            if (s.keyRequirements && s.keyRequirements.length > 0) {
                lines.push('');
                lines.push(`**Key Requirements:**`);
                for (const req of s.keyRequirements) {
                    lines.push(`- ${req}`);
                }
            }
            if (s.keyResponsibilities && s.keyResponsibilities.length > 0) {
                lines.push('');
                lines.push(`**Key Responsibilities:**`);
                for (const resp of s.keyResponsibilities) {
                    lines.push(`- ${resp}`);
                }
            }

            lines.push('');
            lines.push(`**Outreach angle:** ${s.outreachAngle}`);
            lines.push(`> ${s.suggestedMessage}`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    return lines.join('\n');
}

function appendAuditLog(entry) {
    const logPath = path.join(__dirname, '..', 'linkedin-history.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

// ── Since Parser ──
function parseSinceCutoff(value) {
    const match = value.match(/^(\d+)([dhw])$/);
    if (match) {
        const num = parseInt(match[1]);
        const unit = match[2];
        const ms = { d: 86400000, h: 3600000, w: 604800000 }[unit];
        return new Date(Date.now() - num * ms);
    }
    const date = new Date(value);
    if (!isNaN(date.getTime())) return date;
    throw new Error(`Invalid --since value: "${value}". Use formats like 7d, 24h, 2w`);
}

// ── Main ──
async function scanLinkedInJobs(options) {
    const { urls, topic, count, sinceCutoff, scoreThreshold, dryRun } = options;
    const startTime = Date.now();

    const searchUrls = [...urls];

    if (searchUrls.length === 0) {
        console.error('Error: provide at least one LinkedIn search URL.');
        console.error('  Usage: node Skills/linkedin-jobs.js <url1> [url2] [options]');
        process.exit(1);
    }

    console.log(`\nLinkedIn Jobs Signal Scanner`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Topic: ${topic || 'LinkedIn'}`);
    console.log(`Search URLs: ${searchUrls.length}`);
    console.log(`Count per URL: ${count}`);
    console.log(`Actor: ${ACTOR_ID}`);
    console.log(`${'─'.repeat(40)}\n`);

    if (dryRun) {
        console.log('DRY RUN — no Apify calls will be made.\n');
        console.log(`Actor page: ${ACTOR_URL}`);
        console.log(`\nSearch URLs that would be submitted:\n`);
        for (let i = 0; i < searchUrls.length; i++) {
            console.log(`  [${i + 1}] ${searchUrls[i]}`);
        }
        console.log(`\nApify input payload:`);
        console.log(JSON.stringify({ count, scrapeCompany: true, splitByLocation: false, urls: searchUrls }, null, 2));
        console.log(`\nTo run for real, remove --dry-run`);
        return;
    }

    if (!APIFY_TOKEN) {
        console.error('Error: APIFY_API_TOKEN is not set. Copy .env.example to .env and add your token.');
        process.exit(1);
    }

    // Load dedup — prefer Supabase when configured, fall back to .seen-urls.json
    let supabaseSeenUrls = null;
    const { seen: fileSeenUrls, file: seenFile } = loadSeenUrls(topic);
    const seenUrls = fileSeenUrls;
    let dupCount = 0;

    // Submit all URLs in one actor run
    console.log(`Submitting ${searchUrls.length} search URL(s) to Apify...`);

    let allResults = [];
    try {
        const runData = await startActorRun(searchUrls, count);
        const runId = runData.data.id;
        console.log(`  Run ID: ${runId}`);

        const completedRun = await waitForCompletion(runId, '');
        const datasetId = completedRun.defaultDatasetId;

        allResults = await getResults(datasetId);
        console.log(`  Fetched ${allResults.length} results`);

    } catch (err) {
        console.error(`  Error: ${err.message}`);
    }

    // Filter by date if --since provided
    let filtered = allResults;
    if (sinceCutoff && allResults.length > 0) {
        filtered = allResults.filter(r => {
            const posted = r.postedAt || r.publishedAt || r.datePosted || r.postedDate;
            if (!posted) return true;
            return new Date(posted) >= sinceCutoff;
        });
        if (filtered.length < allResults.length) {
            console.log(`  Filtered by date: ${allResults.length - filtered.length} older items removed`);
        }
    }

    // Dedup — use Supabase when configured, otherwise use .seen-urls.json
    if (db.isConfigured()) {
        try {
            const candidateUrls = filtered.map(r => r.url || r.jobUrl || r.link || '').filter(Boolean);
            supabaseSeenUrls = await db.exists('job_signals', 'url', candidateUrls);
            if (supabaseSeenUrls.size > 0) {
                console.log(`  Supabase dedup: ${supabaseSeenUrls.size} already-stored job URLs will be skipped`);
            }
        } catch (err) {
            console.warn(`  Supabase dedup check failed (${err.message}), using .seen-urls.json`);
        }
    }

    const effectiveSeen = supabaseSeenUrls || seenUrls;
    const deduped = filtered.filter(r => {
        const jobUrl = r.url || r.jobUrl || r.link || '';
        if (jobUrl && effectiveSeen.has(jobUrl)) {
            dupCount++;
            return false;
        }
        if (jobUrl && !supabaseSeenUrls) seenUrls.add(jobUrl); // only update file-based set
        return true;
    });

    if (dupCount > 0) {
        console.log(`  Deduped: ${dupCount} previously seen results skipped`);
    }

    if (!supabaseSeenUrls) saveSeenUrls(seenUrls, seenFile); // skip file write when using Supabase

    // Extract signals
    const allSignals = extractJobSignals(deduped);

    // Score signals
    for (const signal of allSignals) {
        scoreSignal(signal);
        mapSignalToOutreach(signal);
    }

    // Detect stacks
    const stacks = detectSignalStacks(allSignals);

    // Apply score threshold
    let finalSignals = allSignals;
    if (scoreThreshold > 0) {
        finalSignals = allSignals.filter(s => s.totalScore >= scoreThreshold);
        if (finalSignals.length < allSignals.length) {
            console.log(`\nScore threshold: ${allSignals.length - finalSignals.length} signals below ${scoreThreshold} filtered out`);
        }
    }

    // Output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const outputTopic = topic || 'LinkedIn';
    const dir = path.join(outputTopic, 'LinkedIn');
    fs.mkdirSync(dir, { recursive: true });

    const jsonFile = path.join(dir, `jobs-${timestamp}.json`);
    const mdFile = path.join(dir, `jobs-${timestamp}.md`);

    const meta = {
        topic: outputTopic,
        source: 'linkedin-jobs',
        scannedAt: new Date().toISOString().split('T')[0],
        urlCount: searchUrls.length,
        totalResults: allResults.length,
        durationMs: Date.now() - startTime
    };

    const outputJSON = buildOutputJSON(finalSignals, stacks, meta);
    fs.writeFileSync(jsonFile, JSON.stringify(outputJSON, null, 2));

    const mdContent = generateMarkdownReport(finalSignals, stacks, meta);
    fs.writeFileSync(mdFile, mdContent);

    // Sync to Supabase
    if (db.isConfigured() && finalSignals.length > 0) {
        try {
            // Upsert companies first, collect id map
            const companyMap = {};
            const uniqueCompanies = [...new Map(
                finalSignals.filter(s => s.companyUrl).map(s => [s.companyUrl, s])
            ).values()];
            for (const s of uniqueCompanies) {
                try {
                    const id = await db.findOrCreateCompany({
                        name:           s.company,
                        linkedin_url:   s.companyUrl,
                        website:        s.companyWebsite || null,
                        industry:       s.industries || null,
                        employee_count: s.companySize || null,
                        segment:        s.segment || null
                    });
                    companyMap[s.companyUrl] = id;
                } catch { /* continue */ }
            }

            // Upsert job_signals
            const signalRows = finalSignals.map(s => ({
                company_id:          companyMap[s.companyUrl] || null,
                source:              'linkedin-jobs',
                category:            s.category,
                type:                s.type,
                title:               s.title,
                url:                 s.url,
                location:            s.location || null,
                current_tools:       s.currentTools || [],
                frameworks:          s.frameworks || [],
                pain_language:       s.painLanguage || [],
                base_score:          s.baseScore,
                total_score:         s.totalScore,
                urgency:             s.urgency,
                urgency_window:      s.urgencyWindow || null,
                outreach_angle:      s.outreachAngle || null,
                suggested_message:   s.suggestedMessage || null,
                key_requirements:    s.keyRequirements || [],
                seniority_level:     s.seniorityLevel || null,
                company_size:        s.companySize || null,
                description_summary: s.descriptionSummary || null,
                posted_at:           s.postedAt || null,
                detected_at:         s.detectedAt
            })).filter(r => r.url);
            await db.upsert('job_signals', signalRows, 'url');
            console.log(`  Supabase: ${signalRows.length} job signal(s) + ${uniqueCompanies.length} company record(s) synced`);
        } catch (err) {
            console.warn(`  Supabase sync failed (${err.message}) — local file is the fallback`);
        }
    }

    appendAuditLog({
        timestamp: new Date().toISOString(),
        script: 'linkedin-jobs',
        topic: outputTopic,
        urlCount: searchUrls.length,
        totalResults: allResults.length,
        signalsFound: finalSignals.length,
        stacks: stacks.length,
        critical: finalSignals.filter(s => s.urgency === 'Critical').length,
        high: finalSignals.filter(s => s.urgency === 'High').length,
        medium: finalSignals.filter(s => s.urgency === 'Medium').length,
        outputFile: jsonFile,
        durationMs: Date.now() - startTime
    });

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Total results scraped:  ${allResults.length}`);
    console.log(`Signals extracted:      ${finalSignals.length}`);
    console.log(`Signal stacks:          ${stacks.length}`);
    console.log(`  Critical:  ${finalSignals.filter(s => s.urgency === 'Critical').length}`);
    console.log(`  High:      ${finalSignals.filter(s => s.urgency === 'High').length}`);
    console.log(`  Medium:    ${finalSignals.filter(s => s.urgency === 'Medium').length}`);
    console.log(`\nSegments:  A: ${finalSignals.filter(s => s.segment === 'A').length}  B: ${finalSignals.filter(s => s.segment === 'B').length}  C: ${finalSignals.filter(s => s.segment === 'C').length}`);
    console.log(`\nSaved to:`);
    console.log(`  ${jsonFile}`);
    console.log(`  ${mdFile}`);
    console.log(`${'='.repeat(50)}\n`);

    return outputJSON;
}

// ── CLI ──
const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    console.log(`
LinkedIn Jobs Signal Scanner

Searches LinkedIn job postings for cybersecurity hiring signals and scores them
using the Intent Signals Playbook.

Uses Apify actor: ${ACTOR_ID}

Usage:
  node Skills/linkedin-jobs.js <url1> [url2] [options]

Options:
  --topic <Name>          Topic directory for output (default: "LinkedIn")
  --count <N>             Max results per search URL (default: 25)
  --since <duration>      Only include results from last N days (e.g., 7d, 30d)
  --score-threshold <N>   Only output signals scoring >= N (default: 0)
  --dry-run               Print URLs and actor info without calling Apify

Examples:
  node Skills/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=IAM&geoId=103644278&f_TPR=r86400" --topic IdentityManagement
  node Skills/linkedin-jobs.js "https://www.linkedin.com/jobs/search/?keywords=CISO" --count 50 --dry-run
    `);
    process.exit(0);
}

const cliUrls = [];
let topic = null;
let count = 25;
let sinceCutoff = null;
let scoreThreshold = 0;
let dryRun = false;

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('https://')) {
        cliUrls.push(arg);
    } else if (arg === '--topic') {
        topic = rawArgs[++i] || null;
    } else if (arg === '--count') {
        count = parseInt(rawArgs[++i]) || 25;
    } else if (arg === '--since') {
        sinceCutoff = parseSinceCutoff(rawArgs[++i]);
    } else if (arg === '--score-threshold') {
        scoreThreshold = parseInt(rawArgs[++i]) || 0;
    } else if (arg === '--dry-run') {
        dryRun = true;
    }
}

if (cliUrls.length === 0) {
    console.error('Error: provide at least one LinkedIn search URL.');
    console.error('  Usage: node Skills/linkedin-jobs.js <url1> [url2] [options]');
    console.error('  Run with --help for full usage.');
    process.exit(1);
}

scanLinkedInJobs({ urls: cliUrls, topic, count, sinceCutoff, scoreThreshold, dryRun });

export { scanLinkedInJobs };
