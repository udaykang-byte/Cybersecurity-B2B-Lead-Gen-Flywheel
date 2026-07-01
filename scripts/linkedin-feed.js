#!/usr/bin/env node

/**
 * LinkedIn Feed Keyword Monitor
 *
 * Searches LinkedIn posts/feed by keyword for IAM/PAM/GRC buying signals.
 * Identifies practitioners discussing pain points, evaluating tools, or
 * announcing identity/security projects. Scores each post for buying intent.
 *
 * Usage:
 *   node scripts/linkedin-feed.js [keyword1] [keyword2...] [options]
 *   node scripts/linkedin-feed.js --topic IdentityManagement          (uses default keywords for topic)
 *
 * Options:
 *   --topic <Name>          Topic directory for output (default: "LinkedIn")
 *   --count <N>             Max posts per keyword (default: 25)
 *   --since <duration>      Date filter: 7d, 30d, etc. (default: 30d)
 *   --score-threshold <N>   Only output posts scoring >= N (default: 0)
 *   --dry-run               Print keywords + actor info, no Apify call
 *
 * Examples:
 *   node scripts/linkedin-feed.js --topic IdentityManagement --count 25
 *   node scripts/linkedin-feed.js "evaluating PAM tools" "CyberArk alternative" --topic PAM
 *   node scripts/linkedin-feed.js --topic GRC --since 7d --score-threshold 5
 *
 * Environment:
 *   Requires APIFY_API_TOKEN in .env
 *
 * Output:
 *   <Topic>/LinkedIn/feed-<timestamp>.json
 *   <Topic>/LinkedIn/feed-<timestamp>.md
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
const ACTOR_ID = 'apimaestro~linkedin-posts-search-scraper-no-cookies';
const ACTOR_URL = 'https://apify.com/apimaestro/linkedin-posts-search-scraper-no-cookies';

// ── Default Keywords by Topic ──
// Problem/feature/use-case keywords — NOT brand names.
// These attract posts from people experiencing pain, not vendors promoting products.
const DEFAULT_KEYWORDS = {

    // ── PAM: Privileged Identity Management ──
    PAM: [
        'privileged identity management tool',
        'PIM solution',
        'PIM vs PAM software',
        'password vaulting solution',
        'privileged password management',
        'session recording and monitoring',
        'privileged session management',
        'just-in-time access',
        'zero standing privileges',
        'credential management software',
        'least privilege access',
        'SSH key management',
        'service account management',
        'privileged remote access',
        'VPN-less remote access',
        'credential rotation automation',
        'break-glass access management',
        'privileged account discovery'
    ],

    // ── Threat / Use Case — problem-aware buyers ──
    PAMThreats: [
        'insider threat prevention',
        'privileged account security',
        'reduce attack surface identity',
        'prevent credential theft',
        'stop lateral movement attacks',
        'ransomware prevention with PAM',
        'third-party vendor access control',
        'remote vendor access management',
        'account takeover prevention'
    ],

    // ── Compliance-driven PAM buyers ──
    PAMCompliance: [
        'PAM for SOX compliance',
        'privileged access for GDPR',
        'HIPAA compliant access management',
        'PCI DSS privileged access',
        'NIST zero trust privileged access',
        'ISO 27001 access management',
        'NERC CIP privileged access',
        'audit trail privileged users',
        'access certification and reviews'
    ],

    // ── Technology / Infrastructure-specific ──
    PAMCloud: [
        'PAM for cloud environments',
        'PAM for AWS',
        'PAM for Azure',
        'multi-cloud identity security',
        'PAM for DevOps',
        'Kubernetes secrets management',
        'PAM for OT ICS environments',
        'OT cybersecurity access control',
        'industrial control system security',
        'PAM for Active Directory',
        'SAP privileged access management',
        'zero trust network access',
        'CIEM cloud identity entitlement',
        'PAM for SaaS applications'
    ],

    // ── Industry vertical buyers ──
    PAMIndustry: [
        'privileged access management for banking',
        'PAM for financial services',
        'healthcare cybersecurity access control',
        'government privileged access management',
        'manufacturing OT security PAM'
    ],

    // ── Bottom-of-funnel / active evaluation ──
    PAMEvaluation: [
        'PAM software pricing',
        'best privileged access management tool',
        'secrets management tool',
        'agent-less privileged access',
        'multi-factor authentication for privileged users',
        'single sign-on for privileged accounts'
    ],

    // ── Identity Management / IGA ──
    IdentityManagement: [
        'identity governance and administration',
        'IGA solution',
        'access sprawl',
        'user provisioning automation',
        'identity lifecycle management',
        'orphaned account cleanup',
        'access recertification campaign',
        'role-based access control implementation',
        'entitlement management',
        'joiner mover leaver process',
        'manual access reviews pain',
        'rubber stamping access reviews',
        'identity program maturity'
    ],

    // ── GRC / Compliance access controls ──
    GRC: [
        'SOX access controls',
        'PCI DSS access management',
        'HIPAA access management',
        'access certification',
        'compliance access reviews',
        'audit findings access control',
        'segregation of duties violation',
        'access recertification',
        'identity audit trail',
        'CMMC compliance identity',
        'FedRAMP access control'
    ],

    // ── DevSecOps / Secrets ──
    DevSecOps: [
        'secrets management tool',
        'credential rotation automation',
        'hardcoded credentials problem',
        'secrets in code',
        'Kubernetes secrets management',
        'CI CD credential security',
        'DevOps privileged access',
        'service account rotation'
    ],

    // ── Competitive Intelligence — brand-name complaint/migration keywords ──
    // These intentionally use competitor names to surface chatter from their customers.
    // Non-vendor-employee posts with complaint or migration phrases = HOT outreach targets.
    CompetitorCyberArk: [
        'replacing CyberArk',
        'migrating from CyberArk',
        'moving away from CyberArk',
        'alternatives to CyberArk',
        'CyberArk too expensive',
        'CyberArk complexity',
        'CyberArk implementation problems',
        'CyberArk agent footprint',
        'CyberArk renewal cost',
        'frustrated with CyberArk',
        'issues with CyberArk',
        'CyberArk support problems'
    ],

    CompetitorBeyondTrust: [
        'replacing BeyondTrust',
        'migrating from BeyondTrust',
        'alternatives to BeyondTrust',
        'BeyondTrust too expensive',
        'BeyondTrust issues',
        'BeyondTrust renewal',
        'moving away from BeyondTrust',
        'BeyondTrust implementation problems'
    ],

    CompetitorDelinea: [
        'replacing Delinea',
        'replacing Thycotic',
        'migrating from Thycotic',
        'migrating from Delinea',
        'alternatives to Delinea',
        'Delinea renewal',
        'Thycotic to Delinea migration',
        'Delinea issues',
        'Delinea too expensive'
    ],

    CompetitorSailPoint: [
        'replacing SailPoint',
        'migrating from SailPoint',
        'alternatives to SailPoint',
        'SailPoint too expensive',
        'SailPoint implementation issues',
        'SailPoint renewal',
        'moving away from SailPoint',
        'SailPoint complexity',
        'frustrated with SailPoint'
    ],

    CompetitorOkta: [
        'replacing Okta',
        'Okta alternative',
        'migrating away from Okta',
        'Okta too expensive',
        'after the Okta breach',
        'Okta outage impact',
        'Okta renewal cost',
        'moving away from Okta',
        'Okta pricing complaints',
        'frustrated with Okta'
    ],

    CompetitorSaviynt: [
        'replacing Saviynt',
        'alternatives to Saviynt',
        'Saviynt renewal',
        'Saviynt issues',
        'migrating from Saviynt',
        'Saviynt implementation problems'
    ],

    CompetitorAll: [
        'ripped out CyberArk',
        'abandoned BeyondTrust',
        'replaced SailPoint',
        'looking for PAM alternative',
        'IGA replacement project',
        'switching identity vendors',
        'PAM vendor switch',
        'migrating PAM tool',
        'replacing our PAM solution',
        'left CyberArk',
        'left BeyondTrust',
        'churned from Okta'
    ]
};

// ── Intent Phrases (active evaluation / buying signals) ──
const EVALUATION_PHRASES = [
    'evaluating', 'looking for', 'anyone recommend', 'comparing',
    'replacing', 'moving away from', 'rfp', 'shortlist', 'vendor selection',
    'tool comparison', 'which tool', 'what tool', 'any recommendations',
    'recommendation for', 'suggestions for', 'looking to replace',
    'thinking about switching', 'considering switching', 'in the market for',
    'procurement', 'buying', 'purchasing decision', 'proof of concept', 'poc',
    'pilot', 'demo request', 'request for proposal', 'bakeoff'
];

const QUESTION_PHRASES = [
    'how do you', 'best way to', 'struggling with', 'anyone dealt with',
    'has anyone', 'any experience with', 'help me understand', 'help us',
    'advice on', 'thoughts on', 'what would you', 'how would you',
    'anyone here use', 'tips for', 'looking for advice'
];

const PROJECT_PHRASES = [
    'implementing', 'rolling out', 'deploying', 'kicked off',
    'starting a project', 'we just started', 'working on', 'building out',
    'standing up', 'going live', 'migration project', 'modernizing',
    'overhaul', 'initiative', 'transformation project'
];

// ── Pain Keywords (aligned with linkedin-jobs.js) ──
const PAIN_KEYWORDS = [
    'manual', 'manual processes', 'lack of visibility', 'access sprawl',
    'identity sprawl', 'no automation', 'spreadsheet', 'legacy',
    'technical debt', 'audit findings', 'audit requirements',
    'security gap', 'compliance gap', 'too many accounts',
    'offboarding', 'orphaned accounts', 'access reviews',
    'rubber stamping', 'over-provisioned',
    'unmanaged service accounts', 'shared credentials', 'shared admin accounts',
    'no visibility into privileged', 'privileged account sprawl', 'admin account sprawl',
    'hardcoded credentials', 'hardcoded passwords', 'excessive privileges',
    'standing privileges', 'standing access', 'lateral movement risk',
    'credential theft', 'insider threat', 'third-party vendor risk',
    'vendor access uncontrolled', 'no audit trail', 'manual access reviews',
    'access recertification', 'certification campaign',
    'cloud entitlement', 'entitlement sprawl', 'shadow it access',
    'zero trust initiative', 'zero trust roadmap', 'implementing zero trust',
    'ot security gap', 'ics access control'
];

// ── Competitor Tools ──
const COMPETITOR_TOOLS = [
    'okta', 'sailpoint', 'cyberark', 'beyondtrust', 'delinea',
    'ping identity', 'onelogin', 'saviynt', 'forgerock', 'auth0',
    'vanta', 'drata', 'secureauth', 'centrify', 'thales',
    'microsoft entra', 'azure ad', 'active directory',
    'thycotic', 'wallix', 'senhasegura', 'arcon', 'krontech',
    'oracle identity', 'ibm isim', 'ibm igm', 'quest one identity', 'omada identity',
    'hashicorp vault', 'conjur', 'akeyless', 'doppler', 'infisical',
    'ermetic', 'sonrai security'
];

// ── Competitive Intelligence: Signal Phrases ──
const COMPETITOR_COMPLAINT_PHRASES = [
    'too expensive', 'too complex', 'too complicated', 'too slow', 'too painful',
    'failed implementation', 'implementation nightmare', 'implementation failed',
    'disappointing', 'frustrating', 'painful to use', 'terrible support',
    'poor support', 'support is bad', 'support tickets', 'would not recommend',
    'not worth it', 'massive footprint', 'agent-heavy', 'resource intensive',
    'renewal came in too high', 'renewal cost', 'pricing is ridiculous',
    'looking for alternatives', 'alternative to', 'issues with', 'problems with',
    'struggling with', 'frustrated with', 'unhappy with', 'disappointed with',
    'burned by', 'outage', 'breach', 'breach response', 'incident response',
    'does not scale', 'hard to manage', 'complex to deploy', 'weeks to implement',
    'months to implement', 'missed the deadline', 'over budget'
];

const COMPETITOR_MIGRATION_PHRASES = [
    'replacing', 'migrating from', 'moving away from', 'switching from',
    'dropped', 'ripping out', 'ripped out', 'uninstalling', 'removed',
    'abandoned', 'transitioning from', 'transitioning away', 'decommissioning',
    'left ', 'churned from', 'renewal was too high', 'could not renew',
    'looking for alternatives', 'in the market for a replacement'
];

// Map of canonical competitor names to text aliases for detection
const COMPETITOR_ALIASES = {
    'CyberArk':        ['cyberark'],
    'BeyondTrust':     ['beyondtrust', 'beyond trust'],
    'Delinea':         ['delinea', 'thycotic', 'secret server'],
    'SailPoint':       ['sailpoint'],
    'Okta':            ['okta'],
    'Saviynt':         ['saviynt'],
    'ForgeRock':       ['forgerock'],
    'Ping Identity':   ['ping identity', 'pingidentity'],
    'Microsoft Entra': ['microsoft entra', 'entra id'],
    'One Identity':    ['one identity', 'quest one identity'],
    'Wallix':          ['wallix'],
    'HashiCorp Vault': ['hashicorp vault']
};

function detectCompetitorSignal(text) {
    const lower = text.toLowerCase();

    const mentionedCompetitors = [];
    for (const [name, aliases] of Object.entries(COMPETITOR_ALIASES)) {
        if (aliases.some(a => lower.includes(a))) {
            mentionedCompetitors.push(name);
        }
    }

    if (mentionedCompetitors.length === 0) return null;

    const isMigration = COMPETITOR_MIGRATION_PHRASES.some(p => lower.includes(p));
    const isComplaint = COMPETITOR_COMPLAINT_PHRASES.some(p => lower.includes(p));
    const isEvaluation = EVALUATION_PHRASES.some(p => lower.includes(p));

    let signalType = 'mention';
    if (isMigration) signalType = 'migration';
    else if (isComplaint) signalType = 'complaint';
    else if (isEvaluation) signalType = 'evaluation';

    return { competitors: mentionedCompetitors, signalType };
}

// ── Noise Filter: Vendor companies (authors at these companies are likely promoting, not buying) ──
const VENDOR_HEADLINE_TERMS = [
    'at okta', '@ okta', '| okta', 'okta |',
    'at sailpoint', '@ sailpoint', '| sailpoint', 'sailpoint |',
    'at cyberark', '@ cyberark', '| cyberark', 'cyberark |',
    'at beyondtrust', '@ beyondtrust', '| beyondtrust', 'beyondtrust |',
    'at delinea', '@ delinea', '| delinea', 'delinea |',
    'at ping identity', 'at pingidentity', 'ping identity |',
    'at onelogin', '@ onelogin', '| onelogin',
    'at saviynt', '@ saviynt', '| saviynt', 'saviynt |',
    'at forgerock', '@ forgerock', 'forgerock |',
    'at auth0', '@ auth0', 'auth0 |',
    'at vanta', '@ vanta', '| vanta', 'vanta |',
    'at drata', '@ drata', '| drata', 'drata |',
    'at hashicorp', '@ hashicorp', 'hashicorp |',
    'at akeyless', '@ akeyless', 'akeyless |',
    'at conjur', '@ conjur',
    'at doppler', '@ doppler', 'doppler |',
    'at infisical', '@ infisical',
    'at secureauth', 'at centrify', 'at thycotic', 'at wallix',
    'at omada', '@ omada identity', 'omada identity |',
    'at semperis', 'at sontara', 'at ermetic',
    'at microsoft', '@ microsoft', 'microsoft |',      // for Entra posts
    'at crowdstrike', 'at palo alto', 'at sentinelone' // adjacent vendors
];

const VENDOR_PROMO_PHRASES = [
    "i'm proud to share", "i am proud to share", "proud to share",
    "proud to announce", "proud to present", "proud to introduce",
    "excited to announce", "excited to share", "excited to introduce",
    "thrilled to announce", "thrilled to share",
    "introducing our", "we just launched", "new feature", "product launch",
    "case study", "customer story", "total economic impact", "forrester study",
    "idc study", "gartner recognizes", "magic quadrant",
    "our platform", "our solution", "our product", "our tool",
    "check out our", "learn more about our",
    "we're thrilled", "we are thrilled", "we're excited to", "we are excited to",
    "roi study", "roi report", "roi of", "roi for",
    "we help companies", "we help organizations", "we help teams",
    "join our webinar", "register for our", "download our", "free trial",
    "schedule a demo", "request a demo", "book a demo",
    "are you ready to eliminate", "are you struggling with",
    "introducing phoebe", "introducing [", "we're hiring"   // startup product launches
];

// ── Noise Filter: Recruiter/staffing headlines ──
const RECRUITER_HEADLINE_TERMS = [
    'recruiter', 'recruiting', 'talent acquisition', 'talent partner',
    'staffing', 'headhunter', 'sourcer', 'executive search',
    'talent specialist', 'recruitment consultant', 'hiring consultant',
    'at hays', 'at kforce', 'at robert half', 'at apex systems',
    'at insight global', 'at tek systems', 'at cognizant staffing',
    'at infosys bpm', 'at tata consultancy', 'at wipro',
    'at leonz', 'at synergetics', 'at cyberec', 'at cyrec'
];

// ── Noise Filter: IAM topic relevance (must have at least one to count intent) ──
const TOPIC_RELEVANCE_TERMS = [
    'iam', 'identity', 'access management', 'privileged', 'pam', 'sso',
    'single sign-on', 'authentication', 'authorization', 'mfa', 'zero trust',
    'compliance', 'audit', 'governance', 'grc', 'okta', 'active directory',
    'cyberark', 'sailpoint', 'delinea', 'beyondtrust', 'entra', 'ping',
    'provisioning', 'deprovisioning', 'credential', 'vault', 'secrets management',
    'permissions', 'rbac', 'abac', 'entitlement', 'access review',
    'certification campaign', 'least privilege', 'service account',
    'privileged account', 'orphaned account', 'access sprawl', 'identity sprawl',
    'password', 'multi-factor', 'directory services', 'ldap', 'saml', 'oauth',
    'zero standing', 'just-in-time', 'pki', 'certificate management'
];

// ── Noise Classifier ──
function classifyNoise(text, authorHeadline, toolsMentioned) {
    const headlineLower = (authorHeadline || '').toLowerCase().replace(/[\u2018\u2019\u201A\u201B]/g, "'");
    // Normalize curly/smart quotes → straight apostrophe so phrase matching works on LinkedIn text
    const textLower = text.toLowerCase().replace(/[\u2018\u2019\u201A\u201B]/g, "'");

    const isAskingForHelp = ['struggling with', 'help us', 'advice on', 'how do you',
        'anyone recommend', 'looking for a solution', 'evaluating', 'which tool',
        'what tool', 'any recommendations', 'best way to'].some(p => textLower.includes(p));

    // 0. Competitor signal override: non-vendor author posting complaint/migration/evaluation
    //    about a competitor = genuine customer chatter — always surface, never filter.
    const compSig = detectCompetitorSignal(text);
    if (compSig && compSig.signalType !== 'mention') {
        const isVendorAuthor = VENDOR_HEADLINE_TERMS.some(t => headlineLower.includes(t));
        if (!isVendorAuthor) return null; // real customer signal — bypass all noise filters
    }

    // 1. Vendor author: works at a known vendor → likely promotional
    const isVendorAuthor = VENDOR_HEADLINE_TERMS.some(t => headlineLower.includes(t));
    if (isVendorAuthor && !isAskingForHelp) return 'vendor-promo';

    // 2. Text-based vendor promo: competitor tool mentioned + promotional language
    //    Catches vendors whose headline doesn't include "at [company]"
    if (toolsMentioned.length > 0 && !isAskingForHelp) {
        const matchedPromo = VENDOR_PROMO_PHRASES.find(p => textLower.includes(p));
        if (matchedPromo) return 'vendor-promo';
    } else if (toolsMentioned.length === 0 && !isAskingForHelp) {
        // No tool detected in text yet — try detecting tools directly in textLower
        const TOOL_NAMES = ['okta', 'sailpoint', 'cyberark', 'beyondtrust', 'delinea',
            'saviynt', 'forgerock', 'auth0', 'ping identity', 'vanta', 'drata', 'hashicorp'];
        const toolInText = TOOL_NAMES.some(t => textLower.includes(t));
        if (toolInText) {
            const matchedPromo = VENDOR_PROMO_PHRASES.find(p => textLower.includes(p));
            if (matchedPromo) return 'vendor-promo';
        }
    }

    // 2b. "At [Vendor], we ..." pattern in text — employee writing a company post
    //    e.g. "At Okta, we believe..." / "Here at CyberArk, we..." / "Here at Okta, ..."
    const vendorNames = ['okta', 'sailpoint', 'cyberark', 'beyondtrust', 'delinea',
        'saviynt', 'forgerock', 'auth0', 'ping identity', 'onelogin', 'vanta', 'drata',
        'hashicorp', 'akeyless', 'thycotic', 'wallix', 'omada', 'secureauth'];
    if (!isAskingForHelp) {
        const hasVendorVoice = vendorNames.some(v =>
            textLower.includes(`at ${v}, we`) ||
            textLower.includes(`here at ${v}`) ||
            textLower.includes(`${v} is proud`) ||
            textLower.includes(`${v} helps `) ||
            textLower.includes(`${v} enables `) ||
            textLower.includes(`${v} delivers `)
        );
        if (hasVendorVoice) return 'vendor-promo';
    }

    // 3. Recruiter/staffing: posting job openings, not buying signals
    const isRecruiter = RECRUITER_HEADLINE_TERMS.some(t => headlineLower.includes(t));
    if (isRecruiter) return 'recruiter';

    // 4. Job-posting text pattern: clearly a hiring post, not a buyer signal
    const isJobPosting = ['send your resume', 'share your resume', 'apply now', 'apply here',
        'dm me your resume', 'email resume to', 'email your resume',
        'we are hiring', "we're hiring", 'join our team',
        'open position', 'job opening', 'immediate opening',
        '🚨 contract role', '🚨 urgent role', '🚨 hiring',
        'now hiring:', '#hiring #', 'contract role:', 'urgent requirement',
        'we are looking for a ', "we're looking for a "].some(p => textLower.includes(p));
    if (isJobPosting) return 'recruiter';

    // 5. Job-seeker posts: person announcing they are looking for work, not buying
    const isJobSeeker = ['i received a layoff', 'i was laid off', 'open to opportunities',
        'open to work', 'looking for my next role', 'looking for my next opportunity',
        'recently laid off', 'recently let go', 'excited to share that i am looking',
        'actively looking', 'job search', 'in between roles'].some(p => textLower.includes(p));
    if (isJobSeeker) return 'off-topic';

    // 5. Off-topic: intent phrases fired but no IAM/security context in the post
    const hasTopicRelevance = TOPIC_RELEVANCE_TERMS.some(t => textLower.includes(t));
    if (!hasTopicRelevance && toolsMentioned.length === 0) return 'off-topic';

    return null;
}

// ── Role Signals (LinkedIn headline keywords) ──
const DECISION_MAKER_ROLES = [
    'ciso', 'chief information security', 'chief security officer',
    'cto', 'vp of security', 'vp security', 'vice president',
    'director of security', 'director of it', 'director of information',
    'head of security', 'head of identity', 'head of it',
    'security manager', 'it manager', 'identity manager'
];

const PRACTITIONER_ROLES = [
    'security engineer', 'identity engineer', 'iam engineer',
    'security architect', 'identity architect',
    'security analyst', 'grc analyst', 'compliance analyst',
    'devops engineer', 'sysadmin', 'system administrator',
    'consultant', 'advisor'
];

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
async function startActorRun(keyword, count) {
    const body = {
        keyword,
        count: Math.max(count, 5)
    };

    const postData = JSON.stringify(body);

    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: `/v2/acts/${ACTOR_ID}/runs`,
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
function detectIntentLevel(text) {
    const lower = text.toLowerCase();

    const evalMatches = EVALUATION_PHRASES.filter(p => lower.includes(p));
    if (evalMatches.length > 0) return { level: 'evaluation', matches: evalMatches, score: 4 };

    const questionMatches = QUESTION_PHRASES.filter(p => lower.includes(p));
    if (questionMatches.length > 0) return { level: 'question', matches: questionMatches, score: 3 };

    const projectMatches = PROJECT_PHRASES.filter(p => lower.includes(p));
    if (projectMatches.length > 0) return { level: 'project', matches: projectMatches, score: 2 };

    return { level: 'discussion', matches: [], score: 0 };
}

function detectPainLanguage(text) {
    const lower = text.toLowerCase();
    return PAIN_KEYWORDS.filter(pain => lower.includes(pain));
}

function detectCompetitorTools(text) {
    const lower = text.toLowerCase();
    return COMPETITOR_TOOLS.filter(tool => lower.includes(tool));
}

function detectAuthorRole(headline) {
    if (!headline) return { tier: 'unknown', score: 0 };
    const lower = headline.toLowerCase();

    if (DECISION_MAKER_ROLES.some(r => lower.includes(r))) {
        return { tier: 'decision-maker', score: 2 };
    }
    if (PRACTITIONER_ROLES.some(r => lower.includes(r))) {
        return { tier: 'practitioner', score: 1 };
    }
    return { tier: 'unknown', score: 0 };
}

function scorePost(post) {
    const text = post.text || '';
    const intent = detectIntentLevel(text);
    const pain = detectPainLanguage(text);
    const tools = detectCompetitorTools(text);
    const role = detectAuthorRole(post.authorHeadline);

    let score = 0;
    const signals = [];

    // Intent (dominant)
    if (intent.score > 0) {
        score += intent.score;
        signals.push({ type: intent.level, matches: intent.matches, pts: intent.score });
    }

    // Pain keywords (capped at 3)
    const painPts = Math.min(pain.length, 3);
    if (painPts > 0) {
        score += painPts;
        signals.push({ type: 'pain', matches: pain.slice(0, 3), pts: painPts });
    }

    // Author role
    if (role.score > 0) {
        score += role.score;
        signals.push({ type: 'role', tier: role.tier, pts: role.score });
    }

    // Competitor signal bonus (only from non-vendor authors, verified in classifyNoise)
    const compSignal = detectCompetitorSignal(text);
    if (compSignal) {
        if (compSignal.signalType === 'migration') {
            score += 4;
            signals.push({ type: 'competitor-migration', competitors: compSignal.competitors, pts: 4 });
        } else if (compSignal.signalType === 'complaint') {
            score += 3;
            signals.push({ type: 'competitor-complaint', competitors: compSignal.competitors, pts: 3 });
        } else if (compSignal.signalType === 'evaluation') {
            // evaluation already captured in EVALUATION_PHRASES — just tag it
            signals.push({ type: 'competitor-evaluation', competitors: compSignal.competitors, pts: 0 });
        }
    }

    // Tool mention adds context but not score by itself
    const tier = score >= 7 ? 'HOT' : score >= 5 ? 'WARM' : 'COLD';

    return { score, tier, intent, pain, tools, role, signals };
}

function extractPosts(rawResults, keyword) {
    const posts = [];

    for (let i = 0; i < rawResults.length; i++) {
        const r = rawResults[i];

        // Field names for apimaestro~linkedin-posts-search-scraper-no-cookies
        // Fallbacks cover other actor variants
        const text = r.text || r.content?.description || r.postContent || r.body || '';
        const authorName = r.author?.name || r.authorName || r.author || r.profileName || '';
        const authorHeadline = r.author?.headline || r.authorHeadline || r.headline || r.jobTitle || '';
        const authorUrl = r.author?.profile_url || r.author?.url || r.authorUrl || r.profileUrl || '';
        const postUrl = r.post_url || r.url || r.postUrl || r.link || '';
        const postedAt = r.posted_at?.date || r.postedAt || r.publishedAt || r.date || r.createdAt || '';
        const likesCount = r.stats?.total_reactions || r.likesCount || r.likes || 0;
        const commentsCount = r.stats?.comments || r.commentsCount || r.comments || 0;
        const repostsCount = r.stats?.shares || r.repostsCount || r.reposts || r.shares || 0;

        if (!text) continue;

        const { score: rawScore, tier: rawTier, intent, pain, tools, role, signals } = scorePost({ text, authorHeadline });
        const noiseType = classifyNoise(text, authorHeadline, tools);
        const competitorSignal = detectCompetitorSignal(text);

        // Penalize off-topic posts; hard-suppress vendor-promo and recruiter
        let score = rawScore;
        let tier = rawTier;
        if (noiseType === 'off-topic') {
            score = Math.max(0, score - 2);
            tier = score >= 7 ? 'HOT' : score >= 5 ? 'WARM' : 'COLD';
        } else if (noiseType === 'vendor-promo' || noiseType === 'recruiter') {
            score = 0;
            tier = 'FILTERED';
        }

        posts.push({
            id: `li-feed-${posts.length + 1}`,
            source: 'linkedin-feed',
            keyword,
            text: text.slice(0, 1000),
            authorName,
            authorHeadline,
            authorUrl,
            url: postUrl,
            postedAt,
            likesCount,
            commentsCount,
            repostsCount,
            detectedAt: new Date().toISOString(),
            score,
            tier,
            noiseType,
            intentLevel: intent.level,
            intentMatches: intent.matches,
            painKeywords: pain,
            toolsMentioned: tools,
            authorRoleTier: role.tier,
            signals,
            competitorSignal
        });
    }

    return posts;
}

// ── Deduplication ──
function loadSeenUrls(topic) {
    const seenFile = topic ? path.join(topic, 'LinkedIn', '.seen-feed-urls.json') : null;
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
function buildOutputJSON(posts, meta) {
    const signal = posts.filter(p => p.tier !== 'FILTERED');
    const filtered = posts.filter(p => p.tier === 'FILTERED');
    const hot = signal.filter(p => p.tier === 'HOT').length;
    const warm = signal.filter(p => p.tier === 'WARM').length;
    const cold = signal.filter(p => p.tier === 'COLD').length;
    const byIntent = {};
    for (const p of signal) {
        byIntent[p.intentLevel] = (byIntent[p.intentLevel] || 0) + 1;
    }
    const byNoise = {};
    for (const p of filtered) {
        byNoise[p.noiseType] = (byNoise[p.noiseType] || 0) + 1;
    }

    return {
        meta: {
            ...meta,
            postsFound: signal.length,
            hot,
            warm,
            cold,
            filtered: filtered.length,
            byNoise,
            byIntent
        },
        posts: signal.sort((a, b) => b.score - a.score),
        filtered: filtered
    };
}

function generateMarkdownReport(posts, filteredPosts, meta) {
    const lines = [];
    const date = new Date().toISOString().split('T')[0];

    lines.push(`# LinkedIn Feed Monitor — Signal Report (${date})`);
    lines.push('');
    lines.push(`**Topic:** ${meta.topic} | **Keywords searched:** ${meta.keywordCount} | **Signal posts:** ${meta.postsFound}`);
    lines.push(`**HOT:** ${meta.hot} | **WARM:** ${meta.warm} | **COLD:** ${meta.cold} | **Filtered out:** ${meta.filtered}`);
    lines.push('');

    if (meta.keywords && meta.keywords.length > 0) {
        lines.push(`**Keywords:** ${meta.keywords.join(' | ')}`);
        lines.push('');
    }

    lines.push('## Summary');
    lines.push('');
    lines.push('| Tier | Count | Action |');
    lines.push('|------|-------|--------|');
    if (meta.hot > 0) lines.push(`| **HOT** | ${meta.hot} | Act within 24-48h — active evaluation signal |`);
    if (meta.warm > 0) lines.push(`| **WARM** | ${meta.warm} | Follow up this week |`);
    if (meta.cold > 0) lines.push(`| **COLD** | ${meta.cold} | Monitor only |`);
    if (meta.filtered > 0) {
        const noiseBreakdown = Object.entries(meta.byNoise || {}).map(([k, v]) => `${v} ${k}`).join(', ');
        lines.push(`| ~~FILTERED~~ | ${meta.filtered} | Suppressed: ${noiseBreakdown} |`);
    }
    lines.push('');

    for (const tierLabel of ['HOT', 'WARM', 'COLD']) {
        const tierPosts = posts.filter(p => p.tier === tierLabel);
        if (tierPosts.length === 0) continue;

        lines.push(`## ${tierLabel} Posts`);
        lines.push('');

        for (const p of tierPosts) {
            lines.push(`### [Score: ${p.score}/10] ${p.authorName || 'Unknown'}`);
            if (p.authorHeadline) lines.push(`**Role:** ${p.authorHeadline}`);
            if (p.authorRoleTier !== 'unknown') lines.push(`**Role tier:** ${p.authorRoleTier}`);
            if (p.keyword) lines.push(`**Matched keyword:** ${p.keyword}`);
            if (p.url) lines.push(`**Post:** ${p.url}`);
            if (p.postedAt) lines.push(`**Posted:** ${p.postedAt}`);
            if (p.likesCount || p.commentsCount) {
                lines.push(`**Engagement:** ${p.likesCount} likes · ${p.commentsCount} comments · ${p.repostsCount} reposts`);
            }
            lines.push('');

            if (p.intentMatches.length > 0) {
                lines.push(`**Intent signals:** ${p.intentMatches.join(', ')} (${p.intentLevel})`);
            }
            if (p.painKeywords.length > 0) {
                lines.push(`**Pain keywords:** ${p.painKeywords.join(', ')}`);
            }
            if (p.toolsMentioned.length > 0) {
                lines.push(`**Tools mentioned:** ${p.toolsMentioned.join(', ')}`);
            }

            lines.push('');
            lines.push(`**Post excerpt:**`);
            lines.push(`> ${p.text.slice(0, 400).replace(/\n/g, ' ')}`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }
    }

    // Filtered section (collapsed summary — no excerpts)
    if (filteredPosts && filteredPosts.length > 0) {
        lines.push('## Filtered Posts (noise — excluded from scoring)');
        lines.push('');
        lines.push('| Author | Reason | Keyword |');
        lines.push('|--------|--------|---------|');
        for (const p of filteredPosts) {
            const name = (p.authorName || 'Unknown').replace(/\|/g, '·');
            lines.push(`| ${name} | ${p.noiseType} | ${p.keyword} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function generateBattleCardReport(posts, meta) {
    const lines = [];
    const date = new Date().toISOString().split('T')[0];

    const compPosts = posts.filter(p => p.competitorSignal && p.tier !== 'FILTERED');

    if (compPosts.length === 0) {
        lines.push(`# Competitive Intelligence — No Signals Found (${date})`);
        lines.push('');
        lines.push('No competitor complaint, migration, or evaluation signals detected in this scan.');
        lines.push(`Scan covered ${meta.keywordCount} keywords in topic: ${meta.topic}`);
        return lines.join('\n');
    }

    lines.push(`# Competitive Intelligence Battle Card (${date})`);
    lines.push('');
    lines.push(`**Topic:** ${meta.topic} | **Total competitor signals:** ${compPosts.length} | **Scan date:** ${date}`);
    lines.push('');

    // Group by competitor
    const byCompetitor = {};
    for (const p of compPosts) {
        for (const comp of p.competitorSignal.competitors) {
            if (!byCompetitor[comp]) byCompetitor[comp] = { migration: [], complaint: [], evaluation: [], mention: [] };
            byCompetitor[comp][p.competitorSignal.signalType].push(p);
        }
    }

    // Summary table
    lines.push('## Signal Summary');
    lines.push('');
    lines.push('| Competitor | Migration 🔥 | Complaint ⚠️ | Evaluation 👀 | Mentions | Priority |');
    lines.push('|-----------|:----------:|:----------:|:-----------:|:-------:|---------|');
    const sorted = Object.entries(byCompetitor)
        .sort((a, b) => {
            const scoreA = a[1].migration.length * 3 + a[1].complaint.length * 2 + a[1].evaluation.length;
            const scoreB = b[1].migration.length * 3 + b[1].complaint.length * 2 + b[1].evaluation.length;
            return scoreB - scoreA;
        });
    for (const [comp, sigs] of sorted) {
        const urgency = sigs.migration.length > 0 ? '🔥 HIGH' : sigs.complaint.length > 1 ? '⚠️ MED' : '👀 LOW';
        lines.push(`| ${comp} | ${sigs.migration.length} | ${sigs.complaint.length} | ${sigs.evaluation.length} | ${sigs.mention.length} | ${urgency} |`);
    }
    lines.push('');

    // Per-competitor drill-down
    for (const [comp, sigs] of sorted) {
        const hasSignals = sigs.migration.length + sigs.complaint.length + sigs.evaluation.length > 0;
        if (!hasSignals) continue;

        lines.push(`## ${comp}`);
        lines.push('');

        if (sigs.migration.length > 0) {
            lines.push(`### 🔥 Migration Signals (${sigs.migration.length}) — Reach Out Immediately`);
            lines.push('');
            lines.push('> These users are actively replacing or leaving. This is the hottest prospect window.');
            lines.push('');
            for (const p of sigs.migration) {
                lines.push(`**${p.authorName || 'Unknown'}** | ${p.authorHeadline || 'Unknown role'} | Score: ${p.score}/10`);
                if (p.url) lines.push(`[View Post](${p.url}) · ${p.postedAt || ''} · ${p.likesCount || 0} likes · ${p.commentsCount || 0} comments`);
                lines.push(`> ${p.text.slice(0, 350).replace(/\n/g, ' ')}`);
                if (p.painKeywords && p.painKeywords.length > 0) {
                    lines.push(`*Pain keywords: ${p.painKeywords.slice(0, 4).join(', ')}*`);
                }
                lines.push('');
            }
        }

        if (sigs.complaint.length > 0) {
            lines.push(`### ⚠️ Complaint Signals (${sigs.complaint.length}) — Warm Prospects`);
            lines.push('');
            lines.push('> Experiencing pain but not yet in replacement mode. Use objections in tailored outreach.');
            lines.push('');
            for (const p of sigs.complaint) {
                lines.push(`**${p.authorName || 'Unknown'}** | ${p.authorHeadline || 'Unknown role'} | Score: ${p.score}/10`);
                if (p.url) lines.push(`[View Post](${p.url}) · ${p.postedAt || ''}`);
                lines.push(`> ${p.text.slice(0, 350).replace(/\n/g, ' ')}`);
                if (p.painKeywords && p.painKeywords.length > 0) {
                    lines.push(`*Pain: ${p.painKeywords.slice(0, 4).join(', ')}*`);
                }
                lines.push('');
            }
        }

        if (sigs.evaluation.length > 0) {
            lines.push(`### 👀 Evaluation Signals (${sigs.evaluation.length}) — Engage Now`);
            lines.push('');
            lines.push('> Actively comparing tools. Comment on the post or connect with personalized insight.');
            lines.push('');
            for (const p of sigs.evaluation) {
                lines.push(`**${p.authorName || 'Unknown'}** | ${p.authorHeadline || 'Unknown role'} | Score: ${p.score}/10`);
                if (p.url) lines.push(`[View Post](${p.url}) · ${p.postedAt || ''}`);
                lines.push(`> ${p.text.slice(0, 350).replace(/\n/g, ' ')}`);
                lines.push('');
            }
        }

        // Objection themes for this competitor
        const objectionPosts = [...sigs.migration, ...sigs.complaint];
        const painTally = {};
        for (const p of objectionPosts) {
            for (const pain of (p.painKeywords || [])) {
                painTally[pain] = (painTally[pain] || 0) + 1;
            }
        }
        const topPains = Object.entries(painTally).sort((a, b) => b[1] - a[1]).slice(0, 6);
        if (topPains.length > 0) {
            lines.push(`**Recurring objection themes for ${comp} customers:**`);
            for (const [pain, count] of topPains) {
                lines.push(`- "${pain}" (${count}x)`);
            }
            lines.push('');
        }

        lines.push('---');
        lines.push('');
    }

    // Outreach playbook
    lines.push('## Outreach Playbook');
    lines.push('');
    if (sorted.length > 0) {
        const [topComp, topSigs] = sorted[0];
        lines.push(`**Highest-priority competitor this week:** ${topComp}`);
        lines.push(`- ${topSigs.migration.length} users actively replacing → send a direct "we can help you migrate" message`);
        lines.push(`- ${topSigs.complaint.length} users complaining → reference specific pain in outreach opener`);
        lines.push(`- ${topSigs.evaluation.length} users comparing tools → comment on their post with a differentiator insight`);
        lines.push('');
        lines.push('**Recommended actions:**');
        lines.push('1. For migration signals: reach out within 24h — they are in vendor selection now');
        lines.push('2. For complaint signals: personalize outreach with the exact pain they described');
        lines.push('3. For evaluation signals: engage publicly on the post, then follow up via DM');
        lines.push('4. Run `/qualify-accounts` on HOT leads to score against ICP before outreach');
    }
    lines.push('');

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
async function scanLinkedInFeed(options) {
    const { topic, keywords: inputKeywords, maxResults = 25, since, scoreThreshold = 0, dryRun = false } = options;
    const startTime = Date.now();

    const outputTopic = topic || 'LinkedIn';

    // Resolve keywords: explicit > topic default > error
    let keywords = inputKeywords;
    if (!keywords || keywords.length === 0) {
        keywords = DEFAULT_KEYWORDS[outputTopic];
        if (!keywords) {
            console.error(`Error: no keywords provided and no defaults for topic "${outputTopic}".`);
            console.error(`  Known topics: ${Object.keys(DEFAULT_KEYWORDS).join(', ')}`);
            console.error('  Or pass keywords directly: node scripts/linkedin-feed.js "keyword1" "keyword2"');
            process.exit(1);
        }
        console.log(`Using default keywords for topic: ${outputTopic}`);
    }

    const sinceCutoff = since ? (since instanceof Date ? since : parseSinceCutoff(since)) : null;

    console.log(`\nLinkedIn Feed Keyword Monitor`);
    console.log(`${'─'.repeat(40)}`);
    console.log(`Topic: ${outputTopic}`);
    console.log(`Keywords: ${keywords.length}`);
    console.log(`Max posts per keyword: ${maxResults}`);
    console.log(`Actor: ${ACTOR_ID}`);
    if (sinceCutoff) console.log(`Since: ${sinceCutoff.toISOString().split('T')[0]}`);
    console.log(`${'─'.repeat(40)}\n`);

    if (dryRun) {
        console.log('DRY RUN — no Apify calls will be made.\n');
        console.log(`Actor page: ${ACTOR_URL}`);
        console.log(`\nKeywords that would be searched:\n`);
        keywords.forEach((kw, i) => console.log(`  [${i + 1}] ${kw}`));
        console.log(`\nSample Apify input payload (per keyword):`);
        console.log(JSON.stringify({ keyword: keywords[0], count: maxResults, sortBy: 'recent' }, null, 2));
        console.log(`\nTo run for real, remove --dry-run`);
        return;
    }

    if (!APIFY_TOKEN) {
        console.error('Error: APIFY_API_TOKEN is not set. Copy .env.example to .env and add your token.');
        process.exit(1);
    }

    // Load dedup
    const { seen: fileSeenUrls, file: seenFile } = loadSeenUrls(outputTopic);
    let supabaseSeenUrls = null;
    let dupCount = 0;

    // Scrape each keyword sequentially
    let allPosts = [];

    for (let i = 0; i < keywords.length; i++) {
        const keyword = keywords[i];
        console.log(`\n[${i + 1}/${keywords.length}] Searching: "${keyword}"`);

        let rawResults = [];
        try {
            const runData = await startActorRun(keyword, maxResults);
            const runId = runData.data.id;
            console.log(`  Run ID: ${runId}`);

            const completedRun = await waitForCompletion(runId, `  [${keyword}]`);
            const datasetId = completedRun.defaultDatasetId;

            rawResults = await getResults(datasetId);
            console.log(`  Fetched ${rawResults.length} posts`);
        } catch (err) {
            console.error(`  Error for "${keyword}": ${err.message}`);
            continue;
        }

        // Date filter
        if (sinceCutoff && rawResults.length > 0) {
            const before = rawResults.length;
            rawResults = rawResults.filter(r => {
                const ts = r.posted_at?.timestamp;
                if (ts) return new Date(ts) >= sinceCutoff;
                const posted = r.posted_at?.date || r.postedAt || r.publishedAt || r.date || r.createdAt;
                if (!posted) return true;
                return new Date(posted) >= sinceCutoff;
            });
            if (rawResults.length < before) {
                console.log(`  Filtered by date: ${before - rawResults.length} older posts removed`);
            }
        }

        // Dedup
        // Pre-load Supabase dedup on first batch
        if (db.isConfigured() && !supabaseSeenUrls) {
            try {
                const candidateUrls = rawResults.map(r => r.url || r.postUrl || r.link || '').filter(Boolean);
                supabaseSeenUrls = await db.exists('feed_signals', 'url', candidateUrls);
            } catch (err) {
                console.warn(`  Supabase dedup check failed (${err.message}), using .seen-feed-urls.json`);
            }
        }
        const effectiveSeen = supabaseSeenUrls || fileSeenUrls;

        const deduped = rawResults.filter(r => {
            const postUrl = r.url || r.postUrl || r.link || '';
            if (postUrl && effectiveSeen.has(postUrl)) {
                dupCount++;
                return false;
            }
            if (postUrl && !supabaseSeenUrls) fileSeenUrls.add(postUrl);
            return true;
        });

        const extracted = extractPosts(deduped, keyword);
        allPosts = allPosts.concat(extracted);

        const kHot = extracted.filter(p => p.tier === 'HOT').length;
        const kWarm = extracted.filter(p => p.tier === 'WARM').length;
        const kFiltered = extracted.filter(p => p.tier === 'FILTERED').length;
        console.log(`  Extracted ${extracted.length} posts (${kHot} HOT, ${kWarm} WARM, ${kFiltered} filtered)`);
    }

    if (dupCount > 0) {
        console.log(`\nDeduped: ${dupCount} previously seen posts skipped across all keywords`);
    }

    if (!supabaseSeenUrls) saveSeenUrls(fileSeenUrls, seenFile);

    // Split signal posts from noise-filtered posts
    const signalPosts = allPosts.filter(p => p.tier !== 'FILTERED');
    const noisePosts = allPosts.filter(p => p.tier === 'FILTERED');

    // Score threshold filter (only applied to signal posts)
    let finalPosts = signalPosts;
    if (scoreThreshold > 0) {
        finalPosts = signalPosts.filter(p => p.score >= scoreThreshold);
        if (finalPosts.length < signalPosts.length) {
            console.log(`Score threshold: ${signalPosts.length - finalPosts.length} posts below ${scoreThreshold} filtered out`);
        }
    }

    // Output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const dir = path.join(outputTopic, 'LinkedIn');
    fs.mkdirSync(dir, { recursive: true });

    const jsonFile = path.join(dir, `feed-${timestamp}.json`);
    const mdFile = path.join(dir, `feed-${timestamp}.md`);

    const meta = {
        topic: outputTopic,
        source: 'linkedin-feed',
        scannedAt: new Date().toISOString().split('T')[0],
        keywordCount: keywords.length,
        keywords,
        postsFound: finalPosts.length,
        hot: finalPosts.filter(p => p.tier === 'HOT').length,
        warm: finalPosts.filter(p => p.tier === 'WARM').length,
        cold: finalPosts.filter(p => p.tier === 'COLD').length,
        filtered: noisePosts.length,
        durationMs: Date.now() - startTime
    };

    const outputJSON = buildOutputJSON([...finalPosts, ...noisePosts], meta);
    fs.writeFileSync(jsonFile, JSON.stringify(outputJSON, null, 2));

    const mdContent = generateMarkdownReport(finalPosts, noisePosts, meta);
    fs.writeFileSync(mdFile, mdContent);

    // Sync to Supabase (signal posts only — noise posts skipped)
    if (db.isConfigured() && finalPosts.length > 0) {
        try {
            const signalRows = finalPosts.filter(p => p.url).map(p => ({
                company_id:       null,  // feed posts don't reliably identify company
                source:           'linkedin-feed',
                keyword:          p.keyword || null,
                author_name:      p.authorName || null,
                author_headline:  p.authorHeadline || null,
                author_url:       p.authorUrl || null,
                url:              p.url,
                post_text:        p.text || null,
                score:            p.score || 0,
                tier:             p.tier || null,
                intent_level:     p.intentLevel || null,
                noise_type:       p.noiseType || null,
                tools_mentioned:  p.toolsMentioned || [],
                pain_keywords:    p.painKeywords || [],
                author_role_tier: p.authorRoleTier || null,
                posted_at:        p.postedAt || null,
                detected_at:      p.detectedAt || new Date().toISOString()
            }));
            await db.upsert('feed_signals', signalRows, 'url');
            console.log(`  Supabase: ${signalRows.length} feed signal(s) synced`);
        } catch (err) {
            console.warn(`  Supabase sync failed (${err.message}) — local file is the fallback`);
        }
    }

    // Battle card: generated for Competitor* topics or whenever competitor signals appear
    const isCompetitorTopic = outputTopic.startsWith('Competitor');
    const hasCompetitorSignals = finalPosts.some(p => p.competitorSignal && p.competitorSignal.signalType !== 'mention');
    if (isCompetitorTopic || hasCompetitorSignals) {
        const battleCardFile = path.join(dir, `battle-card-${timestamp}.md`);
        const battleCardContent = generateBattleCardReport(finalPosts, { ...meta, since: since ? since.toString() : null });
        fs.writeFileSync(battleCardFile, battleCardContent);
        const compSignalCount = finalPosts.filter(p => p.competitorSignal && p.competitorSignal.signalType !== 'mention').length;
        console.log(`\nBattle card: ${compSignalCount} competitor signals → ${battleCardFile}`);
    }

    appendAuditLog({
        timestamp: new Date().toISOString(),
        script: 'linkedin-feed',
        topic: outputTopic,
        keywordCount: keywords.length,
        postsFound: finalPosts.length,
        hot: meta.hot,
        warm: meta.warm,
        cold: meta.cold,
        filtered: noisePosts.length,
        outputFile: jsonFile,
        durationMs: Date.now() - startTime
    });

    // Summary
    console.log(`\n${'='.repeat(50)}`);
    console.log(`RESULTS`);
    console.log(`${'='.repeat(50)}`);
    console.log(`Keywords searched:  ${keywords.length}`);
    console.log(`Signal posts:       ${finalPosts.length}`);
    console.log(`  HOT:      ${meta.hot}`);
    console.log(`  WARM:     ${meta.warm}`);
    console.log(`  COLD:     ${meta.cold}`);
    console.log(`Filtered (noise):   ${noisePosts.length}`);
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
LinkedIn Feed Keyword Monitor

Searches LinkedIn posts by keyword for IAM/PAM/GRC buying signals.
Identifies practitioners evaluating tools, describing pain points, or
announcing identity/security projects.

Uses Apify actor: ${ACTOR_ID}

Usage:
  node scripts/linkedin-feed.js [keyword1] [keyword2...] [options]
  node scripts/linkedin-feed.js --topic IdentityManagement    (uses topic defaults)

Options:
  --topic <Name>          Topic directory for output (default: "LinkedIn")
  --count <N>             Max posts per keyword (default: 25)
  --since <duration>      Date filter: 7d, 30d, etc. (default: no filter)
  --score-threshold <N>   Only output posts scoring >= N (default: 0)
  --dry-run               Print keywords + actor info, no Apify call

Default keyword sets: ${Object.keys(DEFAULT_KEYWORDS).join(', ')}
  PAM/PAMThreats/PAMCompliance/PAMCloud/PAMEvaluation = privileged access buying signals by angle
  IdentityManagement = IGA/governance pain keywords
  GRC = compliance access control keywords
  DevSecOps = secrets management keywords
  CompetitorCyberArk/CompetitorBeyondTrust/CompetitorDelinea = competitor chatter monitoring
  CompetitorSailPoint/CompetitorOkta/CompetitorSaviynt/CompetitorAll = more competitor topics
  → Competitor topics auto-generate a battle-card-<ts>.md with objections + outreach playbook

Examples:
  node scripts/linkedin-feed.js --topic IdentityManagement --count 25
  node scripts/linkedin-feed.js --topic CompetitorCyberArk --since 7d
  node scripts/linkedin-feed.js --topic CompetitorAll --since 14d --score-threshold 5
  node scripts/linkedin-feed.js --topic GRC --since 7d --score-threshold 5
  node scripts/linkedin-feed.js --topic IdentityManagement --dry-run
    `);
    process.exit(0);
}

const cliKeywords = [];
let topic = null;
let count = 25;
let since = null;
let scoreThreshold = 0;
let dryRun = false;

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--topic') {
        topic = rawArgs[++i] || null;
    } else if (arg === '--count') {
        count = parseInt(rawArgs[++i]) || 25;
    } else if (arg === '--since') {
        since = rawArgs[++i];
    } else if (arg === '--score-threshold') {
        scoreThreshold = parseInt(rawArgs[++i]) || 0;
    } else if (arg === '--dry-run') {
        dryRun = true;
    } else if (!arg.startsWith('--')) {
        cliKeywords.push(arg);
    }
}

scanLinkedInFeed({
    topic,
    keywords: cliKeywords.length > 0 ? cliKeywords : null,
    maxResults: count,
    since,
    scoreThreshold,
    dryRun
});

export { scanLinkedInFeed };
