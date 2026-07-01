#!/usr/bin/env node

/**
 * Reddit Lead Enrichment — Profile Scraper + Deep Research
 *
 * Reads a scored leads JSON file, extracts unique usernames from HOT/WARM leads,
 * scrapes their full Reddit profile history via Apify, extracts signals, and
 * optionally uses Perplexity Sonar API for deep prospect research.
 *
 * Usage:
 *   node Skills/enrich-leads.js <leads-json-file> --topic <Name> [options]
 *
 * Examples:
 *   node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement
 *   node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --research
 *   node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --research-only --tiers HOT
 *
 * Options:
 *   --topic <Name>        Topic directory (required)
 *   --tiers <HOT,WARM>    Comma-separated tier filter (default: "HOT,WARM")
 *   --max-users <N>       Max users to enrich (default: 10)
 *   --max-items <N>       Max posts/comments per user profile (default: 100)
 *   --skip-scraped        Skip users with existing Profiles/ data
 *   --research            Enable Perplexity deep research (requires PERPLEXITY_API_KEY)
 *   --research-only       Skip Apify scraping, use cached Profiles/, run research only
 *   --exa                 Use Exa.ai for prospect research (requires EXA_API_KEY)
 *   --exa-only            Skip Apify scraping, use cached Profiles/, run Exa research only
 *
 * Environment:
 *   Requires APIFY_API_TOKEN in .env
 *   Optional: PERPLEXITY_API_KEY for --research mode
 *   Optional: EXA_API_KEY for --exa mode
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './lib/supabase.js';
import { execSync, spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env if available
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const [key, ...valueParts] = trimmed.split('=');
            if (key && valueParts.length) {
                process.env[key.trim()] = valueParts.join('=').trim();
            }
        });
    }
} catch (e) {
    // .env not found, continue
}

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
const EXA_KEY = process.env.EXA_API_KEY;

const ACTOR_PATH = '/v2/acts/louisdeconinck~reddit-user-profile-posts-scraper/runs';
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ── Known IAM / Cybersecurity competitors ────────────────────────────────────
// Any lead whose discovered email domain or company name matches one of these
// will be flagged as DO NOT CONTACT (competitor/vendor, not a buyer).
const COMPETITOR_VENDORS = [
    { name: 'EmpowerID',        domains: ['empowerid.com'],              keywords: ['empowerid'] },
    { name: 'SailPoint',        domains: ['sailpoint.com'],              keywords: ['sailpoint'] },
    { name: 'Saviynt',          domains: ['saviynt.com'],                keywords: ['saviynt'] },
    { name: 'CyberArk',         domains: ['cyberark.com'],               keywords: ['cyberark'] },
    { name: 'Ping Identity',    domains: ['pingidentity.com', 'ping.io'], keywords: ['ping identity', 'pingidentity'] },
    { name: 'Okta',             domains: ['okta.com'],                   keywords: ['okta'] },
    { name: 'OneLogin',         domains: ['onelogin.com'],               keywords: ['onelogin'] },
    { name: 'ForgeRock',        domains: ['forgerock.com'],              keywords: ['forgerock'] },
    { name: 'BeyondTrust',      domains: ['beyondtrust.com'],            keywords: ['beyondtrust'] },
    { name: 'Delinea',          domains: ['delinea.com'],                keywords: ['delinea', 'thycotic', 'centrify'] },
    { name: 'Varonis',          domains: ['varonis.com'],                keywords: ['varonis'] },
    { name: 'Netwrix',          domains: ['netwrix.com'],                keywords: ['netwrix'] },
    { name: 'Semperis',         domains: ['semperis.com'],               keywords: ['semperis'] },
    { name: 'Silverfort',       domains: ['silverfort.com'],             keywords: ['silverfort'] },
    { name: 'Cato Networks',    domains: ['catonetworks.com'],           keywords: ['cato networks'] },
    { name: 'Zscaler',          domains: ['zscaler.com'],                keywords: ['zscaler'] },
    { name: 'Orca Security',    domains: ['orca.security'],              keywords: ['orca security'] },
    { name: 'CrowdStrike',      domains: ['crowdstrike.com'],            keywords: ['crowdstrike'] },
    { name: 'Palo Alto Networks', domains: ['paloaltonetworks.com'],     keywords: ['palo alto networks', 'paloalto'] },
    { name: 'Tenable',          domains: ['tenable.com'],                keywords: ['tenable'] },
    { name: 'Qualys',           domains: ['qualys.com'],                 keywords: ['qualys'] },
    { name: 'Rapid7',           domains: ['rapid7.com'],                 keywords: ['rapid7'] },
    { name: 'IBM Security',     domains: [],                             keywords: ['ibm security', 'ibm verify'] },
    { name: 'Microsoft Entra',  domains: [],                             keywords: ['microsoft entra', 'azure active directory', 'azure ad'] },
    { name: 'Wallix',           domains: ['wallix.com'],                 keywords: ['wallix'] },
    { name: 'Senhasegura',      domains: ['senhasegura.com'],            keywords: ['senhasegura'] },
    { name: 'Arcon',            domains: ['arconnet.com'],               keywords: ['arcon'] },
    { name: 'StrongDM',         domains: ['strongdm.com'],               keywords: ['strongdm'] },
    { name: 'HashiCorp',        domains: ['hashicorp.com'],              keywords: ['hashicorp vault'] },
    { name: 'Omada Identity',   domains: ['omadaidentity.com'],          keywords: ['omada identity'] },
];

// ── HTTP helpers ────────────────────────────────────────────────────────────

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

// ── Apify helpers ───────────────────────────────────────────────────────────

async function startProfileScrape(username, maxItems = 100) {
    const body = {
        proxyConfiguration: {
            useApifyProxy: true,
            apifyProxyGroups: ["RESIDENTIAL"]
        },
        startUrls: [
            { url: `https://www.reddit.com/user/${username}/` }
        ]
    };

    const postData = JSON.stringify(body);

    const options = {
        hostname: 'api.apify.com',
        port: 443,
        path: ACTOR_PATH,
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

        throw new Error(`Failed to start profile scrape: HTTP ${response.status}\n  Response: ${JSON.stringify(response.data)}`);
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
            const runData = response.data?.data || {};
            const msg = runData.statusMessage || 'No details available';
            throw new Error(`Profile scrape ${status}: ${msg}\n  Check run at: https://console.apify.com/actors/runs/${runId}`);
        }

        const delay = Math.min(3000 * Math.pow(1.3, attempts), 15000);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
    }

    throw new Error('Timeout waiting for profile scrape to complete');
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

// ── Lead loading and user extraction ────────────────────────────────────────

function loadLeadsFile(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(`Error: file not found: ${filePath}`);
        process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data.leads || !Array.isArray(data.leads)) {
        console.error('Error: invalid leads file — expected { meta, leads: [...] }');
        process.exit(1);
    }
    return data;
}

function extractUniqueUsers(leads, tierFilter) {
    const tierOrder = { HOT: 0, WARM: 1, COLD: 2 };
    const userMap = new Map();

    for (const lead of leads) {
        if (!tierFilter.has(lead.tier)) continue;

        const username = (lead.author || '').replace(/^u\//, '');
        if (!username) continue;

        if (userMap.has(username)) {
            const existing = userMap.get(username);
            existing.leadIds.push(lead.id);
            if (tierOrder[lead.tier] < tierOrder[existing.tier]) {
                existing.tier = lead.tier;
                existing.topScore = lead.score;
                existing.topExcerpt = lead.excerpt || lead.title || '';
            }
        } else {
            userMap.set(username, {
                username,
                tier: lead.tier,
                topScore: lead.score,
                leadIds: [lead.id],
                topExcerpt: lead.excerpt || lead.title || '',
                url: lead.url
            });
        }
    }

    return [...userMap.values()].sort((a, b) => {
        const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
        if (tierDiff !== 0) return tierDiff;
        return b.topScore - a.topScore;
    });
}

// ── Profile saving / loading ────────────────────────────────────────────────

function saveUserProfile(username, profileData, topic) {
    const dir = path.join(topic, 'Profiles');
    fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `${username}.json`);
    const output = {
        username,
        scrapedAt: new Date().toISOString(),
        totalItems: profileData.length,
        posts: profileData.filter(i => i.dataType === 'post' || i.type === 'post').length,
        comments: profileData.filter(i => i.dataType === 'comment' || i.type === 'comment').length,
        items: profileData
    };

    fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
    return filePath;
}

function profileExists(username, topic) {
    return fs.existsSync(path.join(topic, 'Profiles', `${username}.json`));
}

function loadCachedProfile(username, topic) {
    const filePath = path.join(topic, 'Profiles', `${username}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// ── Signal Extraction (local analysis) ──────────────────────────────────────

function extractSignals(username, profileItems) {
    const signals = {
        companyHints: [],
        roleHints: [],
        locationHints: [],
        techStack: new Set(),
        vendorFlags: [],
        subreddits: new Set(),
        summary: ''
    };

    if (!profileItems || profileItems.length === 0) {
        signals.summary = 'No profile data available.';
        signals.techStack = [];
        signals.subreddits = [];
        return signals;
    }

    const productMentions = {};

    for (const item of profileItems) {
        const text = ((item.body || item.text || '') + ' ' + (item.title || '')).toLowerCase();
        const originalText = (item.body || item.text || '') + ' ' + (item.title || '');
        const sub = (item.communityName || item.subreddit || '').toLowerCase();

        if (sub) signals.subreddits.add(sub);

        // Company hints
        const companyPatterns = [
            /(?:at my (?:company|org|organization|workplace))[,.]?\s*(?:we|they|i)/i,
            /(?:i work (?:at|for|in))\s+([^,.]+)/i,
            /(?:our (?:company|org|organization|team|department))\s+(?:uses?|runs?|has|deployed)/i,
            /(?:we (?:use|run|deploy|have|implemented|migrated))\s+/i,
            /(?:my (?:employer|company|org))/i,
        ];
        for (const pattern of companyPatterns) {
            const match = originalText.match(pattern);
            if (match) {
                signals.companyHints.push(match[0].slice(0, 120));
            }
        }

        // Role hints
        const rolePatterns = [
            /(?:i(?:'m| am) (?:a|an|the))\s+([^,.]+(?:engineer|manager|analyst|architect|admin|director|lead|specialist|consultant|officer))/i,
            /(?:i manage)\s+(?:a |an |the )?([^,.]+(?:team|department|group))/i,
            /(?:as (?:a|an|the))\s+([^,.]+(?:engineer|manager|analyst|architect|admin))/i,
            /(?:my role|my job|my position)\s+(?:is|as)\s+([^,.]+)/i,
            /(\d+)\s*(?:years?|yrs?)\s+(?:in|of|doing)\s+(?:IAM|identity|IT|security|cyber)/i,
        ];
        for (const pattern of rolePatterns) {
            const match = originalText.match(pattern);
            if (match) {
                signals.roleHints.push(match[0].slice(0, 120));
            }
        }

        // Location hints
        const locationPatterns = [
            /zone\s+(\d+[ab]?)\b/i,
            /(?:i(?:'m| am) (?:in|from|based in))\s+([^,.]+)/i,
            /(?:alberta|ontario|british columbia|quebec|california|texas|new york|london|uk|canada|australia)/i,
        ];
        for (const pattern of locationPatterns) {
            const match = originalText.match(pattern);
            if (match) {
                signals.locationHints.push(match[0].slice(0, 80));
            }
        }

        // Location from subreddits
        const locationSubs = {
            'legaladviceuk': 'UK', 'ukpersonalfinance': 'UK', 'casualuk': 'UK',
            'calgary': 'Calgary, Canada', 'edmonton': 'Edmonton, Canada', 'alberta': 'Alberta, Canada',
            'canada': 'Canada', 'australia': 'Australia', 'westjet': 'Canada',
        };
        if (locationSubs[sub]) {
            signals.locationHints.push(`Subreddit: r/${sub} → ${locationSubs[sub]}`);
        }

        // Tech stack
        const techTerms = [
            'okta', 'entra id', 'azure ad', 'active directory', 'sailpoint', 'saviynt',
            'cyberark', 'beyondtrust', 'ping identity', 'auth0', 'onelogin', 'jumpcloud',
            'conditional access', 'fido2', 'passkeys', 'saml', 'oauth', 'oidc', 'scim',
            'midpoint', 'keycloak', 'teleport', 'lumos', 'allthenticate', 'corma',
            'palo alto', 'fortinet', 'cato networks', 'zscaler', 'crowdstrike',
            'servicenow', 'jira', 'splunk', 'sentinel', 'nist 800-63',
            'wren:idm', 'orchid security', 'layerx', 'orca security',
            // PAM vendors
            'delinea', 'thycotic', 'wallix', 'senhasegura', 'arcon',
            // Secrets management
            'hashicorp vault', 'conjur', 'akeyless', 'doppler', 'infisical',
            // Cloud identity
            'aws iam', 'azure pim', 'azure privileged identity',
            'aws secrets manager', 'gcp iam',
            // JIT / infrastructure access
            'boundary', 'strongdm', 'indent',
            // OT/ICS security
            'claroty', 'dragos', 'nozomi',
            // IGA
            'omada',
        ];
        for (const term of techTerms) {
            if (text.includes(term)) {
                signals.techStack.add(term);
            }
        }

        // Vendor flags — track how many times specific products are promoted
        const vendorProducts = ['cato networks', 'orchid security', 'layerx', 'orca security', 'corma', 'lumos'];
        for (const product of vendorProducts) {
            if (text.includes(product)) {
                productMentions[product] = (productMentions[product] || 0) + 1;
            }
        }
    }

    // Flag vendors mentioned 3+ times across different posts
    for (const [product, count] of Object.entries(productMentions)) {
        if (count >= 3) {
            signals.vendorFlags.push(`${product} mentioned ${count} times — possible vendor affiliation`);
        }
    }

    // Deduplicate hints
    signals.companyHints = [...new Set(signals.companyHints)].slice(0, 5);
    signals.roleHints = [...new Set(signals.roleHints)].slice(0, 5);
    signals.locationHints = [...new Set(signals.locationHints)].slice(0, 5);
    signals.techStack = [...signals.techStack];
    signals.subreddits = [...signals.subreddits];

    // Build summary
    const parts = [];
    if (signals.roleHints.length > 0) parts.push(`Role signals: ${signals.roleHints.join('; ')}`);
    if (signals.companyHints.length > 0) parts.push(`Company signals: ${signals.companyHints.join('; ')}`);
    if (signals.locationHints.length > 0) parts.push(`Location: ${signals.locationHints.join('; ')}`);
    if (signals.techStack.length > 0) parts.push(`Tech: ${signals.techStack.join(', ')}`);
    if (signals.vendorFlags.length > 0) parts.push(`VENDOR WARNING: ${signals.vendorFlags.join('; ')}`);
    signals.summary = parts.join('. ') || 'No strong signals found.';

    return signals;
}

// ── Perplexity Sonar API ────────────────────────────────────────────────────

async function queryPerplexity(messages) {
    const body = {
        model: 'sonar',
        messages
    };

    const postData = JSON.stringify(body);

    const options = {
        hostname: 'api.perplexity.ai',
        port: 443,
        path: '/chat/completions',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PERPLEXITY_KEY}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const maxRetries = 3;
    const backoffDelays = [2000, 5000, 15000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const response = await makeRequest(options, postData);

        if (response.status === 200) {
            return response.data;
        }

        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries - 1) {
            const delay = backoffDelays[attempt];
            console.log(`  Perplexity API returned ${response.status}, retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
        }

        throw new Error(`Perplexity API error: HTTP ${response.status}\n  Response: ${JSON.stringify(response.data)}`);
    }
}

async function researchProspect(username, signals, topExcerpt) {
    const signalParts = [];
    if (signals.roleHints.length > 0) signalParts.push(`Their role appears to be: ${signals.roleHints.join(', ')}`);
    if (signals.companyHints.length > 0) signalParts.push(`Company clues: ${signals.companyHints.join(', ')}`);
    if (signals.locationHints.length > 0) signalParts.push(`Location signals: ${signals.locationHints.join(', ')}`);
    if (signals.techStack.length > 0) signalParts.push(`Technologies they use: ${signals.techStack.join(', ')}`);

    const professionalSubs = signals.subreddits.filter(s =>
        ['identitymanagement', 'iam', 'cybersecurity', 'sysadmin', 'netsec', 'msp',
         'networking', 'devops', 'grc', 'compliance'].includes(s)
    );
    if (professionalSubs.length > 0) signalParts.push(`Active in professional subreddits: ${professionalSubs.join(', ')}`);

    const query = `Find the professional identity and contact information for Reddit user "${username}".

Context from their Reddit activity:
${signalParts.join('\n')}

A relevant quote from them: "${(topExcerpt || '').slice(0, 300)}"

Please research and provide:
1. Their likely real name (if discoverable)
2. Their employer/company
3. Their job title or role
4. Their LinkedIn profile URL
5. Their professional email (or email pattern from company domain)
6. Any other relevant professional background

If you cannot find definitive information, provide your best assessment based on the signals and explain your reasoning. Clearly mark anything that is inferred vs confirmed.`;

    const messages = [
        {
            role: 'system',
            content: 'You are a B2B sales research assistant. Your job is to find professional contact information for prospects based on their online activity signals. Be thorough but honest — clearly distinguish between confirmed facts and inferences. Always provide LinkedIn URLs when found.'
        },
        { role: 'user', content: query }
    ];

    return await queryPerplexity(messages);
}

function parsePerplexityResponse(response) {
    const result = {
        answer: '',
        citations: [],
        linkedin: null,
        realName: null,
        company: null,
        email: null,
        role: null
    };

    if (!response || !response.choices || !response.choices[0]) {
        return result;
    }

    result.answer = response.choices[0].message?.content || '';
    result.citations = response.citations || [];

    // Extract LinkedIn URL
    const linkedinMatch = result.answer.match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/);
    if (linkedinMatch) {
        result.linkedin = 'https://www.' + linkedinMatch[0];
    }

    // Extract email pattern
    const emailMatch = result.answer.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}\b/);
    if (emailMatch) {
        result.email = emailMatch[0];
    }

    return result;
}

// ── Exa.ai API ──────────────────────────────────────────────────────────────

async function queryExa(query, options = {}) {
    const body = {
        query,
        type: 'auto',
        numResults: 10,
        contents: {
            text: { maxCharacters: 10000 }
        },
        ...options
    };

    const postData = JSON.stringify(body);

    const reqOptions = {
        hostname: 'api.exa.ai',
        port: 443,
        path: '/search',
        method: 'POST',
        headers: {
            'x-api-key': EXA_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const maxRetries = 3;
    const backoffDelays = [2000, 5000, 15000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const response = await makeRequest(reqOptions, postData);

        if (response.status === 200) {
            return response.data;
        }

        if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries - 1) {
            const delay = backoffDelays[attempt];
            console.log(`  Exa API returned ${response.status}, retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
        }

        throw new Error(`Exa API error: HTTP ${response.status}\n  Response: ${JSON.stringify(response.data)}`);
    }
}

async function researchProspectExa(username, signals, topExcerpt, githubData = null) {
    const professionalSubs = signals.subreddits.filter(s =>
        ['identitymanagement', 'iam', 'cybersecurity', 'sysadmin', 'netsec', 'msp',
         'networking', 'devops', 'grc', 'compliance'].includes(s)
    );

    // If GitHub gave us a real name, use it for a much more precise people search
    const realName = githubData?.realName;
    const githubCompany = githubData?.company;

    // Build contextual keyword string from Reddit signals (or GitHub data if available)
    const contextKeywords = realName
        ? [`"${realName}"`, githubCompany, 'cybersecurity IAM'].filter(Boolean).join(' ')
        : [
            ...signals.roleHints.slice(0, 2),
            ...signals.techStack.slice(0, 3),
            ...signals.locationHints.slice(0, 1),
            ...(professionalSubs.length > 0 ? [professionalSubs[0]] : []),
            'cybersecurity'
          ].filter(Boolean).join(' ');

    const allResults = [];

    // Search 1: People/LinkedIn lookup using role + tech + location signals
    if (contextKeywords.length > 10) {
        try {
            const peopleData = await queryExa(contextKeywords, {
                category: 'person',
                numResults: 5,
                contents: { text: { maxCharacters: 5000 } }
            });
            if (peopleData?.results?.length > 0) {
                allResults.push(...peopleData.results);
            }
        } catch (err) {
            // Fall through to next search
        }
    }

    // Search 2: Username + contextual keywords from Reddit activity
    const topTech = signals.techStack.slice(0, 2).join(' ');
    const usernameQuery = [
        `"${username}"`,
        topTech,
        professionalSubs.length > 0 ? professionalSubs[0] : 'IAM',
        'cybersecurity'
    ].filter(Boolean).join(' ');

    try {
        const usernameData = await queryExa(usernameQuery, {
            type: 'auto',
            numResults: 5,
            contents: { text: { maxCharacters: 5000 } }
        });
        if (usernameData?.results?.length > 0) {
            allResults.push(...usernameData.results);
        }
    } catch (err) {
        // Fall through
    }

    // Search 3: Company news if we have a company hint
    if (signals.companyHints.length > 0) {
        const companyQuery = `${signals.companyHints[0].slice(0, 60)} cybersecurity IAM security`;
        try {
            const companyData = await queryExa(companyQuery, {
                category: 'company',
                numResults: 3,
                contents: { text: { maxCharacters: 3000 } }
            });
            if (companyData?.results?.length > 0) {
                allResults.push(...companyData.results);
            }
        } catch (err) {
            // Fall through
        }
    }

    return allResults;
}

function parseExaResponse(results) {
    const parsed = {
        answer: '',
        citations: [],
        linkedin: null,
        email: null
    };

    if (!results || results.length === 0) {
        return parsed;
    }

    // Collect all citations
    parsed.citations = results.map(r => r.url).filter(Boolean);

    // Build answer summary from titles + URLs
    parsed.answer = results
        .slice(0, 8)
        .map(r => `${r.title || 'Result'}: ${r.url}`)
        .join('\n');

    // Search all result text for LinkedIn URL and email
    for (const result of results) {
        const text = (result.text || '') + ' ' + (result.url || '') + ' ' + (result.title || '');

        if (!parsed.linkedin) {
            const linkedinMatch = text.match(/linkedin\.com\/in\/[a-zA-Z0-9_-]+/);
            if (linkedinMatch) {
                parsed.linkedin = 'https://www.' + linkedinMatch[0];
            }
        }

        if (!parsed.email) {
            const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}\b/);
            if (emailMatch && !emailMatch[0].startsWith('noreply') && !emailMatch[0].startsWith('no-reply')) {
                parsed.email = emailMatch[0];
            }
        }

        if (parsed.linkedin && parsed.email) break;
    }

    return parsed;
}

// ── Competitor detection ─────────────────────────────────────────────────────

/**
 * Check email domain and company name against known IAM/cybersecurity vendors.
 * Returns { isCompetitor, vendorName, reason } or { isCompetitor: false }.
 */
function detectCompetitor(email, companyName) {
    const emailDomain = email ? (email.split('@')[1] || '').toLowerCase() : '';
    const companyLower = (companyName || '').toLowerCase();

    for (const vendor of COMPETITOR_VENDORS) {
        // Email domain match
        if (emailDomain) {
            for (const domain of vendor.domains) {
                if (emailDomain === domain || emailDomain.endsWith('.' + domain)) {
                    return { isCompetitor: true, vendorName: vendor.name, reason: `email domain ${emailDomain} belongs to ${vendor.name}` };
                }
            }
        }
        // Company name / keyword match
        if (companyLower) {
            for (const keyword of vendor.keywords) {
                if (companyLower.includes(keyword)) {
                    return { isCompetitor: true, vendorName: vendor.name, reason: `company "${companyName}" matches ${vendor.name}` };
                }
            }
        }
    }
    return { isCompetitor: false, vendorName: null, reason: null };
}

// ── Sherlock username search ─────────────────────────────────────────────────

function getSherlockCmd() {
    // Common pip user install paths + standard locations
    const candidates = [
        'sherlock',
        `${process.env.HOME}/Library/Python/3.9/bin/sherlock`,
        `${process.env.HOME}/Library/Python/3.10/bin/sherlock`,
        `${process.env.HOME}/Library/Python/3.11/bin/sherlock`,
        `${process.env.HOME}/.local/bin/sherlock`,
        '/usr/local/bin/sherlock',
    ];
    for (const cmd of candidates) {
        try {
            execSync(`"${cmd}" --version`, { stdio: 'pipe' });
            return [cmd];
        } catch {
            // try next
        }
    }
    return null;
}

function checkSherlockInstalled() {
    return getSherlockCmd() !== null;
}

function runSherlock(username, topic) {
    const cacheFile = path.join(topic, 'Profiles', `sherlock-${username}.csv`);

    // Return cached result if available
    if (fs.existsSync(cacheFile)) {
        return fs.readFileSync(cacheFile, 'utf8');
    }

    const outputDir = path.join(topic, 'Profiles');
    fs.mkdirSync(outputDir, { recursive: true });

    const sherlockCmd = getSherlockCmd();
    if (!sherlockCmd) return null;

    const [bin, ...baseArgs] = sherlockCmd;
    const result = spawnSync(
        bin,
        [...baseArgs, username, '--print-found', '--csv', '--folderoutput', outputDir, '--timeout', '5'],
        { encoding: 'utf8', timeout: 90000 }
    );

    if (result.status !== 0 || result.error) {
        return null;
    }

    // Sherlock writes <username>.csv in the output folder
    const sherlockOut = path.join(outputDir, `${username}.csv`);
    if (fs.existsSync(sherlockOut)) {
        const csv = fs.readFileSync(sherlockOut, 'utf8');
        // Rename to our cache filename
        fs.renameSync(sherlockOut, cacheFile);
        return csv;
    }

    return null;
}

function parseSherlockCsv(csvContent) {
    const profiles = {
        github: null,
        linkedin: null,
        twitter: null,
        hackerNews: null,
        devto: null,
        allFound: []
    };

    if (!csvContent) return profiles;

    const lines = csvContent.split('\n').filter(Boolean);
    // Skip header line
    for (const line of lines.slice(1)) {
        const cols = line.split(',');
        if (cols.length < 4) continue;
        const name = (cols[1] || '').trim().toLowerCase();
        const url = (cols[3] || cols[2] || '').trim();
        const exists = (cols[4] || '').trim();

        if (exists !== 'Claimed') continue;

        profiles.allFound.push({ platform: cols[1]?.trim(), url });

        if (name === 'github') profiles.github = url;
        else if (name === 'linkedin') profiles.linkedin = url;
        else if (name === 'twitter' || name === 'x (twitter)' || name === 'x') profiles.twitter = url;
        else if (name === 'hackernews' || name === 'hacker news') profiles.hackerNews = url;
        else if (name === 'dev.to' || name === 'devto') profiles.devto = url;
    }

    return profiles;
}

async function enrichFromGithub(username, githubUrl) {
    if (!EXA_KEY) return { realName: null, company: null, location: null, email: null };

    try {
        const data = await queryExa(`github ${username} profile`, {
            includeDomains: ['github.com'],
            numResults: 1,
            contents: { text: { maxCharacters: 3000 } }
        });

        const text = data?.results?.[0]?.text || '';
        if (!text) return { realName: null, company: null, location: null, email: null };

        // GitHub profile text patterns
        const realNameMatch = text.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+)+)/m);
        const companyMatch = text.match(/(?:^|\n)([A-Z][^\n]{1,60}(?:Inc|LLC|Corp|Ltd|Co\.|Technologies|Solutions|Security|Systems|Group|Labs|Software|Cloud|Networks|Services))/m)
            || text.match(/@([A-Za-z0-9_-]+)/);
        const locationMatch = text.match(/(?:Location|📍)[:\s]+([^\n]+)/i);
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}\b/);

        return {
            realName: realNameMatch ? realNameMatch[1].trim() : null,
            company: companyMatch ? (companyMatch[1] || companyMatch[0]).trim().replace(/^@/, '') : null,
            location: locationMatch ? locationMatch[1].trim() : null,
            email: emailMatch ? emailMatch[0] : null
        };
    } catch {
        return { realName: null, company: null, location: null, email: null };
    }
}

// ── Enriched output generation ──────────────────────────────────────────────

function buildEnrichedLead(user, signals, perplexityResult) {
    const enriched = {
        username: user.username,
        doNotContact: perplexityResult?.doNotContact || false,
        competitorFlag: perplexityResult?.competitorFlag || null,
        originalLead: {
            id: user.leadIds[0],
            score: user.topScore,
            tier: user.tier,
            suggestedOutreach: user.topExcerpt
        },
        profile: {
            company: perplexityResult?.company || (signals.companyHints[0] || 'Unknown'),
            companyConfidence: perplexityResult?.company ? 'medium' : (signals.companyHints.length > 0 ? 'low' : 'low'),
            role: perplexityResult?.role || (signals.roleHints[0] || 'Unknown'),
            roleConfidence: perplexityResult?.role ? 'medium' : (signals.roleHints.length > 0 ? 'low' : 'low'),
            industry: 'Cybersecurity / IAM',
            location: signals.locationHints[0] || 'Unknown',
            techStack: signals.techStack,
            painPoints: [],
            buyingSignals: [],
            vendorFlags: signals.vendorFlags,
            redditActivity: {
                totalItems: user.profileData?.length || 0,
                topSubreddits: signals.subreddits.slice(0, 10)
            }
        },
        contactInfo: {
            linkedin: perplexityResult?.linkedin || 'Not found',
            email: perplexityResult?.email || 'Not found',
            companyWebsite: 'Not found',
            contactConfidence: perplexityResult?.linkedin ? 'medium' : 'low'
        },
        perplexityResearch: perplexityResult?.answer || null,
        perplexityCitations: perplexityResult?.citations || [],
        signalSummary: signals.summary
    };

    return enriched;
}

function generateEnrichedMarkdown(enrichedLeads, meta) {
    const lines = [];
    const today = meta.enrichedAt;

    lines.push(`# ${meta.topic} — Enriched Lead Report (${today})`);
    lines.push('');
    const competitorNote = meta.competitorsDetected > 0 ? ` | **Competitors flagged:** ${meta.competitorsDetected}` : '';
    lines.push(`**Source:** ${meta.sourceLeadsFile} | **Enriched:** ${meta.totalEnriched} users | **Research:** ${meta.researchEngine || 'None'}${competitorNote}`);
    lines.push('');
    lines.push('---');

    for (const lead of enrichedLeads) {
        lines.push('');
        lines.push(`## u/${lead.username} — ${lead.originalLead.tier} (Score ${lead.originalLead.score}/10)`);
        lines.push('');

        if (lead.doNotContact && lead.competitorFlag) {
            lines.push(`> **🚫 DO NOT CONTACT — COMPETITOR DETECTED**`);
            lines.push(`> ${lead.competitorFlag}`);
            lines.push('');
        }

        if (lead.profile.vendorFlags && lead.profile.vendorFlags.length > 0) {
            lines.push(`**VENDOR WARNING:** ${lead.profile.vendorFlags.join('; ')}`);
            lines.push('');
        }

        lines.push(`**Company:** ${lead.profile.company} (${lead.profile.companyConfidence} confidence)`);
        lines.push(`**Role:** ${lead.profile.role} (${lead.profile.roleConfidence} confidence)`);
        lines.push(`**Location:** ${lead.profile.location}`);
        lines.push('');

        if (lead.profile.techStack.length > 0) {
            lines.push(`**Tech Stack:** ${lead.profile.techStack.join(', ')}`);
            lines.push('');
        }

        lines.push('### Contact Info');
        lines.push(`- **LinkedIn:** ${lead.contactInfo.linkedin}`);
        lines.push(`- **Email:** ${lead.contactInfo.email}`);
        lines.push(`- **Confidence:** ${lead.contactInfo.contactConfidence}`);
        lines.push('');

        lines.push('### Signal Summary');
        lines.push(lead.signalSummary);
        lines.push('');

        if (lead.sherlockProfiles && lead.sherlockProfiles.allFound.length > 0) {
            lines.push('### Sherlock Profiles Found');
            const sp = lead.sherlockProfiles;
            if (sp.github) lines.push(`- **GitHub:** ${sp.github}`);
            if (sp.linkedin) lines.push(`- **LinkedIn:** ${sp.linkedin}`);
            if (sp.twitter) lines.push(`- **Twitter/X:** ${sp.twitter}`);
            if (sp.hackerNews) lines.push(`- **HackerNews:** ${sp.hackerNews}`);
            if (sp.devto) lines.push(`- **Dev.to:** ${sp.devto}`);
            const others = sp.allFound.filter(p => !['GitHub','LinkedIn','Twitter','X (Twitter)','X','HackerNews','Hacker News','dev.to','DevTo'].includes(p.platform));
            if (others.length > 0) {
                lines.push(`- **Other (${others.length}):** ${others.slice(0, 5).map(p => p.platform).join(', ')}`);
            }
            lines.push('');
        }

        if (lead.githubData && (lead.githubData.realName || lead.githubData.company)) {
            lines.push('### GitHub Identity Data');
            if (lead.githubData.realName) lines.push(`- **Real Name:** ${lead.githubData.realName}`);
            if (lead.githubData.company) lines.push(`- **Company:** ${lead.githubData.company}`);
            if (lead.githubData.location) lines.push(`- **Location:** ${lead.githubData.location}`);
            if (lead.githubData.email) lines.push(`- **Email:** ${lead.githubData.email}`);
            lines.push('');
        }

        if (lead.exaResearch) {
            lines.push('### Exa Research');
            lines.push(lead.exaResearch);
            lines.push('');

            if (lead.exaCitations && lead.exaCitations.length > 0) {
                lines.push('**Sources:**');
                for (const cite of lead.exaCitations) {
                    lines.push(`- ${cite}`);
                }
                lines.push('');
            }
        } else if (lead.perplexityResearch) {
            lines.push('### Perplexity Research');
            lines.push(lead.perplexityResearch);
            lines.push('');

            if (lead.perplexityCitations && lead.perplexityCitations.length > 0) {
                lines.push('**Sources:**');
                for (const cite of lead.perplexityCitations) {
                    lines.push(`- ${cite}`);
                }
                lines.push('');
            }
        }

        lines.push('---');
    }

    return lines.join('\n');
}

// ── Format for Claude (fallback when no --research) ─────────────────────────

function formatForClaude(userProfiles, originalLeads, topic, sourceFile) {
    const today = new Date().toISOString().slice(0, 10);
    const lines = [];

    lines.push('REDDIT LEAD ENRICHMENT REQUEST');
    lines.push(`Source file: ${sourceFile}`);
    lines.push(`Topic: ${topic}`);
    lines.push(`Users to enrich: ${userProfiles.length}`);
    lines.push(`Generated: ${today}`);
    lines.push('');
    lines.push('Instructions: For each user below, analyze their full Reddit history to extract:');
    lines.push('1. Company/employer (from mentions like "at my company", "I work at", "our org")');
    lines.push('2. Job title / role (from context: "I\'m a security engineer", "I manage a team")');
    lines.push('3. Industry / sector');
    lines.push('4. Location hints');
    lines.push('5. Technologies they use');
    lines.push('6. Pain points / buying signals');
    lines.push('7. Any contact info shared publicly');
    lines.push('');
    lines.push('Then do web searches to find:');
    lines.push('- LinkedIn profile (search: "<real name or username> <company> <role> site:linkedin.com")');
    lines.push('- Company website');
    lines.push('- Email (from company domain patterns)');
    lines.push('');
    lines.push('Save results as:');
    lines.push(`- ${topic}/Enriched/enriched-${today}.json`);
    lines.push(`- ${topic}/Enriched/enriched-${today}.md`);
    lines.push('');
    lines.push('Use the enriched output schema documented in the plan.');

    for (let idx = 0; idx < userProfiles.length; idx++) {
        const { username, tier, topScore, topExcerpt, url, profileData } = userProfiles[idx];

        lines.push('');
        lines.push('='.repeat(60));
        lines.push('');
        lines.push(`USER ${idx + 1}: u/${username}`);
        lines.push(`Original Lead: Score ${topScore}/10 (${tier})`);
        lines.push(`Original Excerpt: "${(topExcerpt || '').slice(0, 300)}"`);
        if (url) lines.push(`Lead URL: ${url}`);

        if (!profileData || profileData.length === 0) {
            lines.push('');
            lines.push('--- Reddit History: NO DATA (account may be deleted or private) ---');
            continue;
        }

        lines.push('');
        lines.push(`--- Reddit History (${profileData.length} items) ---`);

        for (let i = 0; i < profileData.length; i++) {
            const item = profileData[i];
            const type = (item.dataType || item.type || 'unknown').toUpperCase();
            const sub = item.communityName || item.subreddit || 'unknown';
            const date = item.createdAt ? new Date(item.createdAt).toISOString().slice(0, 10) : 'unknown';
            const title = item.title || '';
            const body = (item.body || item.text || '').slice(0, 800);

            lines.push(`[${i + 1}] ${type} in ${sub} (${date})`);
            if (title) lines.push(`    Title: "${title}"`);
            if (body) lines.push(`    Body: ${body}${(item.body || item.text || '').length > 800 ? '...' : ''}`);
            lines.push('');
        }
    }

    return lines.join('\n');
}

// ── Main orchestrator ───────────────────────────────────────────────────────

async function enrichLeads(leadsFile, topic, tierFilter, maxUsers, maxItems, skipScraped, doResearch, researchOnly, doExa, exaOnly, doSherlock) {
    const startTime = Date.now();

    // Mutually exclusive: --exa takes precedence if both set
    if (doExa && doResearch) {
        console.warn('Warning: --exa and --research both set. Using --exa.');
        doResearch = false;
    }

    const isResearchMode = doResearch || doExa;
    const isCacheOnly = researchOnly || exaOnly;

    // Check Sherlock installation
    let sherlockAvailable = false;
    if (doSherlock) {
        sherlockAvailable = checkSherlockInstalled();
        if (!sherlockAvailable) {
            console.warn('Warning: sherlock not installed — skipping username search.');
            console.warn('Install with: pip install sherlock-project');
        }
    }

    // Validate tokens
    if (!isCacheOnly && !APIFY_TOKEN) {
        console.error('Error: APIFY_API_TOKEN is not set. Copy .env.example to .env and add your token.');
        process.exit(1);
    }
    if (doResearch && !PERPLEXITY_KEY) {
        console.error('Error: PERPLEXITY_API_KEY is not set. Add it to .env for --research mode.');
        console.error('Get your key at https://docs.perplexity.ai/');
        process.exit(1);
    }
    if (doExa && !EXA_KEY) {
        console.error('Error: EXA_API_KEY is not set. Add it to .env for --exa mode.');
        console.error('Get your key at https://dashboard.exa.ai/api-keys');
        process.exit(1);
    }

    console.log('\nReddit Lead Enrichment');
    if (doExa) console.log('Mode: Deep Research (Exa.ai)');
    else if (doResearch) console.log('Mode: Deep Research (Perplexity Sonar)');
    if (doSherlock && sherlockAvailable) console.log('Mode: Sherlock username search enabled');
    if (isCacheOnly) console.log('Mode: Research-only (using cached profiles)');
    console.log(`${'─'.repeat(50)}`);

    // 1. Load leads
    const leadsData = loadLeadsFile(leadsFile);
    console.log(`Loaded ${leadsData.leads.length} leads from ${leadsFile}`);

    // 2. Extract unique users
    const users = extractUniqueUsers(leadsData.leads, tierFilter);
    const tierStr = [...tierFilter].join(', ');
    console.log(`Found ${users.length} unique users in tiers: ${tierStr}`);

    if (users.length === 0) {
        console.log('No users to enrich. Try expanding --tiers or using a different leads file.');
        return;
    }

    // 3. Apply max-users cap
    const capped = users.slice(0, maxUsers);
    if (users.length > maxUsers) {
        console.log(`Capping to ${maxUsers} users (use --max-users to change)`);
    }

    // 4. Scrape or load profiles
    const allProfiles = [];

    if (isCacheOnly) {
        // Load all from cache
        for (const user of capped) {
            const profile = loadCachedProfile(user.username, topic);
            if (profile) {
                allProfiles.push({ ...user, profileData: profile.items });
                console.log(`  Loaded cached profile: u/${user.username} (${profile.totalItems} items)`);
            } else {
                console.log(`  No cached profile for u/${user.username} — skipping`);
            }
        }
    } else {
        // Check for cached profiles
        let toScrape = capped;
        let cached = [];
        if (skipScraped) {
            toScrape = capped.filter(u => !profileExists(u.username, topic));
            cached = capped.filter(u => profileExists(u.username, topic));
            if (cached.length > 0) {
                console.log(`Skipping ${cached.length} already-scraped users (--skip-scraped)`);
            }
        }

        // Cost estimate
        const estCost = (toScrape.length * maxItems * 0.003).toFixed(2);
        if (toScrape.length > 0) {
            console.log(`\nWill scrape ${toScrape.length} user profile(s)`);
            console.log(`Estimated Apify cost: ~$${estCost} (${maxItems} items/user at $0.003/result)`);
            console.log('');
        }

        // Scrape profiles
        for (let i = 0; i < toScrape.length; i++) {
            const user = toScrape[i];
            const label = `[${i + 1}/${toScrape.length}]`;
            console.log(`${label} Scraping u/${user.username} (${user.tier})...`);

            try {
                const runData = await startProfileScrape(user.username, maxItems);
                const runId = runData.data.id;
                console.log(`${label}   Run ID: ${runId}`);

                const completedRun = await waitForCompletion(runId, label);
                const datasetId = completedRun.defaultDatasetId;

                let results = await getResults(datasetId);
                if (results.length > maxItems) {
                    results = results.slice(0, maxItems);
                }

                console.log(`${label}   Fetched ${results.length} items`);
                const savedPath = saveUserProfile(user.username, results, topic);
                console.log(`${label}   Saved to ${savedPath}`);

                allProfiles.push({ ...user, profileData: results });
            } catch (err) {
                console.error(`${label}   Error: ${err.message}`);
                allProfiles.push({ ...user, profileData: [] });
            }

            if (i < toScrape.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Load cached profiles
        for (const user of cached) {
            const profile = loadCachedProfile(user.username, topic);
            allProfiles.push({ ...user, profileData: profile ? profile.items : [] });
        }
    }

    // Sort: HOT first
    const tierOrder = { HOT: 0, WARM: 1, COLD: 2 };
    allProfiles.sort((a, b) => {
        const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
        if (tierDiff !== 0) return tierDiff;
        return b.topScore - a.topScore;
    });

    // 5. Extract signals from Reddit history
    console.log('\nExtracting signals from Reddit history...');
    const userSignals = {};
    for (const user of allProfiles) {
        const signals = extractSignals(user.username, user.profileData);
        userSignals[user.username] = signals;
        console.log(`  u/${user.username}: ${signals.techStack.length} tech, ${signals.companyHints.length} company hints, ${signals.locationHints.length} location hints${signals.vendorFlags.length > 0 ? ' ⚠️ VENDOR FLAG' : ''}`);
    }

    // 6a. Sherlock username search (if --sherlock)
    const sherlockData = {};
    const githubEnrichment = {};
    if (doSherlock && sherlockAvailable) {
        console.log('\nRunning Sherlock username search...');
        for (const user of allProfiles) {
            // Skip deleted/private accounts with no Reddit activity
            if (!user.profileData || user.profileData.length === 0) {
                console.log(`  u/${user.username} — skipping Sherlock (no Reddit activity)`);
                sherlockData[user.username] = { github: null, linkedin: null, twitter: null, hackerNews: null, devto: null, allFound: [] };
                continue;
            }
            process.stdout.write(`  u/${user.username}... `);
            const csv = runSherlock(user.username, topic);
            const profiles = parseSherlockCsv(csv);
            sherlockData[user.username] = profiles;

            const found = profiles.allFound.length;
            const highlights = [profiles.github && 'GitHub', profiles.linkedin && 'LinkedIn', profiles.twitter && 'Twitter'].filter(Boolean);
            console.log(`${found} found${highlights.length ? ` (${highlights.join(', ')})` : ''}`);

            // GitHub → extract real name/company for enhanced Exa query
            if (profiles.github && EXA_KEY) {
                process.stdout.write(`    GitHub enrichment... `);
                const ghData = await enrichFromGithub(user.username, profiles.github);
                githubEnrichment[user.username] = ghData;
                const ghSummary = [ghData.realName, ghData.company].filter(Boolean).join(' @ ') || 'no identity data';
                console.log(ghSummary);
            } else {
                githubEnrichment[user.username] = { realName: null, company: null, location: null, email: null };
            }
        }
    }

    // 6b. Research (Perplexity --research or Exa --exa)
    const researchResults = {};
    if (isResearchMode) {
        const engineLabel = doExa ? 'Exa.ai' : 'Perplexity Sonar';
        console.log(`\nRunning ${engineLabel} deep research...`);
        for (let i = 0; i < allProfiles.length; i++) {
            const user = allProfiles[i];
            const signals = userSignals[user.username];
            const label = `[${i + 1}/${allProfiles.length}]`;

            // Skip users with vendor flags
            if (signals.vendorFlags.length > 0) {
                console.log(`${label} u/${user.username} — SKIPPED (vendor affiliation detected)`);
                researchResults[user.username] = null;
                continue;
            }

            console.log(`${label} Researching u/${user.username}...`);
            try {
                let parsed;
                if (doExa) {
                    const ghData = githubEnrichment[user.username] || null;
                    const results = await researchProspectExa(user.username, signals, user.topExcerpt, ghData);
                    parsed = parseExaResponse(results);
                } else {
                    const response = await researchProspect(user.username, signals, user.topExcerpt);
                    parsed = parsePerplexityResponse(response);
                }

                // Prefer Sherlock LinkedIn (direct username match) over Exa-extracted LinkedIn
                const sherlockLinkedin = sherlockData[user.username]?.linkedin;
                if (sherlockLinkedin && !parsed.linkedin) {
                    parsed.linkedin = sherlockLinkedin;
                }

                // Competitor detection: check email domain + known company signals
                const ghCompany = githubEnrichment[user.username]?.company || null;
                const signalCompany = signals.companyHints[0] || null;
                const candidateCompany = ghCompany || signalCompany;
                const competitorCheck = detectCompetitor(parsed.email, candidateCompany);
                if (competitorCheck.isCompetitor) {
                    parsed.doNotContact = true;
                    parsed.competitorFlag = `DO NOT CONTACT — ${competitorCheck.vendorName}: ${competitorCheck.reason}`;
                }

                researchResults[user.username] = parsed;
                console.log(`${label}   LinkedIn: ${parsed.linkedin || 'not found'} | Email: ${parsed.email || 'not found'}`);
                if (competitorCheck.isCompetitor) {
                    console.log(`${label}   ⚠️  COMPETITOR: ${competitorCheck.vendorName} — ${competitorCheck.reason}`);
                }
                if (parsed.citations.length > 0) {
                    console.log(`${label}   Citations: ${parsed.citations.length} sources`);
                }
            } catch (err) {
                console.error(`${label}   ${doExa ? 'Exa' : 'Perplexity'} error: ${err.message}`);
                researchResults[user.username] = null;
            }

            // Rate limit delay
            if (i < allProfiles.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    // 7. Generate outputs
    const today = new Date().toISOString().slice(0, 10);
    const enrichDir = path.join(topic, 'Enriched');
    fs.mkdirSync(enrichDir, { recursive: true });

    if (isResearchMode || doSherlock) {
        // Build enriched leads
        const enrichedLeads = allProfiles.map(user => {
            const researchResult = researchResults[user.username] || null;
            const lead = buildEnrichedLead(user, userSignals[user.username], researchResult);

            // Attach engine-specific research field
            if (doExa && researchResult) {
                lead.exaResearch = researchResult.answer || null;
                lead.exaCitations = researchResult.citations || [];
            }

            // Attach Sherlock + GitHub enrichment data
            if (doSherlock) {
                lead.sherlockProfiles = sherlockData[user.username] || { github: null, linkedin: null, twitter: null, hackerNews: null, devto: null, allFound: [] };
                lead.githubData = githubEnrichment[user.username] || { realName: null, company: null, location: null, email: null };

                // Upgrade contact info with GitHub email if Exa didn't find one
                if (lead.githubData.email && lead.contactInfo.email === 'Not found') {
                    lead.contactInfo.email = lead.githubData.email;
                    lead.contactInfo.contactConfidence = 'medium';
                }
            }

            return lead;
        });

        const meta = {
            topic,
            sourceLeadsFile: leadsFile,
            enrichedAt: today,
            totalEnriched: enrichedLeads.length,
            contactFound: enrichedLeads.filter(l => l.contactInfo.email !== 'Not found').length,
            linkedinFound: enrichedLeads.filter(l => l.contactInfo.linkedin !== 'Not found').length,
            competitorsDetected: enrichedLeads.filter(l => l.doNotContact).length,
            researchEngine: doExa ? (doSherlock ? 'Exa + Sherlock' : 'Exa') : doSherlock ? 'Sherlock' : 'Perplexity Sonar'
        };

        // Save JSON
        const jsonPath = path.join(enrichDir, `enriched-${today}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify({ meta, enrichedLeads }, null, 2));
        console.log(`\nSaved enriched JSON → ${jsonPath}`);

        // Sync to Supabase
        if (db.isConfigured() && enrichedLeads.length > 0) {
            try {
                const contactRows = enrichedLeads
                    .filter(e => e.username && !e.doNotContact)
                    .map(e => ({
                        reddit_username:    e.username,
                        company:            e.profile?.company || null,
                        company_confidence: e.profile?.companyConfidence || null,
                        role:               e.profile?.role || null,
                        role_confidence:    e.profile?.roleConfidence || null,
                        industry:           e.profile?.industry || null,
                        location:           e.profile?.location || null,
                        tech_stack:         e.profile?.techStack || [],
                        pain_points:        e.profile?.painPoints || [],
                        buying_signals:     e.profile?.buyingSignals || [],
                        linkedin_url:       e.contactInfo?.linkedin || null,
                        email:              e.contactInfo?.email || null,
                        company_website:    e.contactInfo?.companyWebsite || null,
                        contact_confidence: e.contactInfo?.contactConfidence || null,
                        do_not_contact:     e.doNotContact || false,
                        competitor_flag:    e.competitorFlag || null,
                        enriched_at:        new Date().toISOString(),
                        updated_at:         new Date().toISOString()
                    }));
                await db.upsert('enriched_contacts', contactRows, 'reddit_username');
                console.log(`  Supabase: ${contactRows.length} enriched contact(s) synced`);
            } catch (err) {
                console.warn(`  Supabase sync failed (${err.message}) — local file is the fallback`);
            }
        }

        // Save Markdown
        const mdPath = path.join(enrichDir, `enriched-${today}.md`);
        const mdContent = generateEnrichedMarkdown(enrichedLeads, meta);
        fs.writeFileSync(mdPath, mdContent);
        console.log(`Saved enriched report → ${mdPath}`);
    }

    // Always generate pending-enrichment.txt for Claude follow-up
    const enrichmentText = formatForClaude(allProfiles, leadsData.leads, topic, leadsFile);
    const pendingPath = path.join(topic, 'pending-enrichment.txt');
    fs.writeFileSync(pendingPath, enrichmentText);
    console.log(`Saved pending enrichment → ${pendingPath}`);

    // 8. Audit log
    const logEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        topic,
        sourceLeadsFile: leadsFile,
        usersEnriched: allProfiles.length,
        tierFilter: [...tierFilter],
        profilesScraped: isCacheOnly ? 0 : allProfiles.length,
        researchEnabled: isResearchMode,
        researchEngine: doExa ? (doSherlock ? 'Exa + Sherlock' : 'Exa') : doSherlock ? 'Sherlock' : doResearch ? 'Perplexity Sonar' : null,
        outputFile: (isResearchMode || doSherlock) ? path.join(enrichDir, `enriched-${today}.json`) : pendingPath,
        durationMs: Date.now() - startTime
    });
    const logPath = path.join(__dirname, '..', 'enrichment-history.jsonl');
    fs.appendFileSync(logPath, logEntry + '\n');

    // 9. Next steps
    console.log(`\n${'─'.repeat(50)}`);
    if (isResearchMode || doSherlock) {
        const engineName = doExa ? (doSherlock ? 'Exa.ai + Sherlock' : 'Exa.ai') : doSherlock ? 'Sherlock' : 'Perplexity';
        console.log(`Enrichment complete with ${engineName} research.`);
        console.log(`Review the report: ${path.join(enrichDir, `enriched-${today}.md`)}`);
        console.log(`\nFor deeper follow-up, ask Claude: "Review ${pendingPath}"`);
    } else {
        console.log('Next step — ask Claude to enrich:');
        console.log(`  "Enrich the leads in ${pendingPath}"`);
        console.log('');
        console.log('Or re-run with --exa for automated Exa.ai research:');
        console.log(`  node Skills/enrich-leads.js ${leadsFile} --topic ${topic} --exa-only`);
        console.log('Or re-run with --research for automated Perplexity research:');
        console.log(`  node Skills/enrich-leads.js ${leadsFile} --topic ${topic} --research-only`);
    }
    console.log(`${'─'.repeat(50)}\n`);
}

// ── CLI arg parsing ─────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0) {
    console.log(`
Reddit Lead Enrichment — Profile Scraper + Deep Research

Usage:
  node Skills/enrich-leads.js <leads-json-file> --topic <Name> [options]

Options:
  --topic <Name>        Topic directory (required)
  --tiers <HOT,WARM>    Comma-separated tier filter (default: "HOT,WARM")
  --max-users <N>       Max users to enrich (default: 10)
  --max-items <N>       Max posts/comments per user profile (default: 100)
  --skip-scraped        Skip users with existing Profiles/ data
  --research            Enable Perplexity deep research (requires PERPLEXITY_API_KEY)
  --research-only       Skip Apify scraping, use cached Profiles/, run research only
  --exa                 Use Exa.ai for prospect research (requires EXA_API_KEY)
  --exa-only            Skip Apify scraping, use cached Profiles/, run Exa research only
  --sherlock            Run Sherlock username search across 400+ platforms (requires: pip install sherlock-project)
                        Finds GitHub, LinkedIn (username match), Twitter, HackerNews, Dev.to
                        If GitHub found, extracts real name/company to enhance Exa queries
                        Combinable with --exa or --exa-only for maximum enrichment

Examples:
  Maximum enrichment (Sherlock → GitHub → Exa → LinkedIn):
    node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --exa-only --sherlock --tiers HOT

  Sherlock only (no Exa API cost):
    node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --sherlock --tiers HOT

  Full automated pipeline with Exa.ai research:
    node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --exa

  Exa research only (profiles already cached):
    node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --exa-only --tiers HOT

  Full automated pipeline with Perplexity research:
    node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --research

  Perplexity research only (profiles already cached):
    node Skills/enrich-leads.js IdentityManagement/Leads/leads-2026-03-14.json --topic IdentityManagement --research-only --tiers HOT
    `);
    process.exit(0);
}

let leadsFile = null;
let topic = null;
let tiers = new Set(['HOT', 'WARM']);
let maxUsers = 10;
let maxItems = 100;
let skipScraped = false;
let doResearch = false;
let researchOnly = false;
let doExa = false;
let exaOnly = false;
let doSherlock = false;

for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--topic') {
        topic = rawArgs[++i] || null;
    } else if (arg === '--tiers') {
        const val = rawArgs[++i] || 'HOT,WARM';
        tiers = new Set(val.split(',').map(t => t.trim().toUpperCase()));
    } else if (arg === '--max-users') {
        maxUsers = parseInt(rawArgs[++i]) || 10;
    } else if (arg === '--max-items') {
        maxItems = parseInt(rawArgs[++i]) || 100;
    } else if (arg === '--skip-scraped') {
        skipScraped = true;
    } else if (arg === '--research') {
        doResearch = true;
    } else if (arg === '--research-only') {
        doResearch = true;
        researchOnly = true;
        skipScraped = true;
    } else if (arg === '--exa') {
        doExa = true;
    } else if (arg === '--exa-only') {
        doExa = true;
        exaOnly = true;
        skipScraped = true;
    } else if (arg === '--sherlock') {
        doSherlock = true;
    } else if (!arg.startsWith('--') && !leadsFile) {
        leadsFile = arg;
    }
}

if (!leadsFile) {
    console.error('Error: leads JSON file is required as the first argument.');
    process.exit(1);
}

if (!topic) {
    console.error('Error: --topic is required.');
    process.exit(1);
}

enrichLeads(leadsFile, topic, tiers, maxUsers, maxItems, skipScraped, doResearch, researchOnly, doExa, exaOnly, doSherlock);

export { enrichLeads };
