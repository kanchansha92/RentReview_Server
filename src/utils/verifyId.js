
const { createWorker, PSM } = require('tesseract.js');
const { signedAssetUrl } = require('./cloudinaryAssets');

// ─────────────────────────────────────────────────────────────────────────────
// ID proof verification
//
// The rule this file enforces: the uploaded document must actually BE an ID of
// the selected type, and it must carry the ID number the submitter typed. Both
// have to be read off the image. Anything else is rejected at submit time.
//
// It FAILS CLOSED. If the document cannot be fetched, rendered or recognised,
// the submission is rejected — "we could not check it" is not "it is fine".
// This is the whole point of the file: an unverifiable document that still
// became a live review is the exact hole this closes.
//
// Two escape hatches, neither of them on by default:
//   ID_VERIFY_MODE=advisory      nothing is ever rejected; everything is queued
//                                for manual review (the old behaviour).
//   ID_VERIFY_ON_ERROR=pending   mismatches are still rejected, but OUR OWN
//                                failures (proof unfetchable, OCR crashed) queue
//                                for manual review instead of rejecting.
// ─────────────────────────────────────────────────────────────────────────────
const MODE = process.env.ID_VERIFY_MODE === 'advisory' ? 'advisory' : 'enforce';
const ON_ERROR = process.env.ID_VERIFY_ON_ERROR === 'pending' ? 'pending' : 'reject';

// A masked Aadhaar (`XXXX XXXX 1234`) is what UIDAI itself hands out, so the
// full number is unreadable on a perfectly genuine card. When the card is
// clearly masked AND the visible last four match what was typed, that counts.
// Set ID_VERIFY_ALLOW_MASKED=false to demand the full number instead.
const ALLOW_MASKED = process.env.ID_VERIFY_ALLOW_MASKED !== 'false';

const FETCH_TIMEOUT_MS = 12000;
// Whole-verification ceiling. OCR runs inside the request, so a pathological
// document must not hold the connection open indefinitely. Raised from 55s when
// the zoom tiles were added: a screenshot that fails the full-image pass has
// five more renders to get through, and cutting them off at 55s would reject
// exactly the images the tiles exist for.
const TOTAL_BUDGET_MS = Number(process.env.ID_VERIFY_BUDGET_MS) || 80000;

const DEBUG_OCR_TEXT = process.env.ID_VERIFY_DEBUG_OCR === 'true';

if (DEBUG_OCR_TEXT) {
    console.warn(
        '⚠️  ID_VERIFY_DEBUG_OCR=true — the full OCR text of every ID proof (name, DOB, ID number) ' +
        'is being written to the log. Unset this outside local development.'
    );
}
if (MODE === 'advisory') {
    console.warn(
        '⚠️  ID_VERIFY_MODE=advisory — ID proofs are NOT being enforced. Every submission is accepted ' +
        'and queued for manual review, including ones that fail the check.'
    );
}
if (ON_ERROR === 'pending') {
    console.warn(
        '⚠️  ID_VERIFY_ON_ERROR=pending — a proof that cannot be fetched or read is accepted and queued ' +
        'instead of rejected. Anything that breaks the fetch becomes a way past the check.'
    );
}

// ─── Tesseract worker pool ───────────────────────────────────────────────────
// OCR is in the request path, so the old "spawn a worker per recognise()"
// approach is far too expensive: each call reloaded the language data before it
// read a single character. Workers are created once and reused; the semaphore
// caps how many documents are recognised at a time.
const POOL_SIZE = Math.max(1, Number(process.env.ID_VERIFY_OCR_WORKERS) || 2);

let permits = POOL_SIZE;
const waiting = [];
const acquire = () =>
    new Promise((resolve) => {
        if (permits > 0) {
            permits -= 1;
            resolve();
        } else {
            waiting.push(resolve);
        }
    });
const release = () => {
    const next = waiting.shift();
    // Hand the permit straight to the next waiter, otherwise return it to the pool.
    if (next) next();
    else permits = Math.min(POOL_SIZE, permits + 1);
};

const idleWorkers = [];

const withWorker = async (fn) => {
    await acquire();
    let worker = idleWorkers.pop();
    try {
        if (!worker) worker = await createWorker('eng');
        const result = await fn(worker);
        idleWorkers.push(worker);
        worker = null;
        return result;
    } catch (err) {
        // A worker that threw is not trusted back into the pool.
        if (worker) {
            try { await worker.terminate(); } catch { /* already gone */ }
        }
        throw err;
    } finally {
        release();
    }
};

/** Terminate pooled workers (tests, CLI, graceful shutdown). Safe to call twice. */
const shutdownOcr = async () => {
    const workers = idleWorkers.splice(0, idleWorkers.length);
    await Promise.all(workers.map((w) => w.terminate().catch(() => { })));
};

// ─── Content sniffing ────────────────────────────────────────────────────────
// The client-declared mimetype is a single header and therefore a one-header
// bypass. Decide from the bytes we actually downloaded instead.
const sniffFormat = (buf) => {
    if (!buf || buf.length < 4) return 'unknown';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';   // %PDF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';                     // FF D8 FF
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';   // \x89PNG
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';   // GIF8
    return 'unknown';
};

// ─── What each document looks like ───────────────────────────────────────────
// Matched against the OCR text with spaces removed, so "A A D H A A R"-style
// letter spacing still hits. Short tokens are matched exactly; longer ones
// tolerate one OCR slip.
const ID_KEYWORDS = {
    'Aadhaar Card': [
        'AADHAAR', 'AADHAR', 'ADHAAR', 'UIDAI', 'UNIQUEIDENTIFICATION',
        'UNIQUEIDENTITY', 'MERAAADHAAR', 'MERIPEHCHAN', 'AAMAADMIKAADHIKAR',
    ],
    'PAN Card': [
        'INCOMETAX', 'INCOMETAXDEPARTMENT', 'PERMANENTACCOUNTNUMBER',
        'PERMANENTACCOUNT', 'ACCOUNTNUMBERCARD', 'INCOMETAXPAN',
    ],
    'Driving License': [
        'DRIVINGLICENCE', 'DRIVINGLICENSE', 'TRANSPORTDEPARTMENT',
        'LICENCETODRIVE', 'MOTORVEHICLE', 'DLNO', 'COVOFVEH',
    ],
    'Passport': [
        'PASSPORT', 'REPUBLICOFINDIA', 'TYPECOUNTRYCODE', 'PASSPORTNO',
    ],
    'Voter ID': [
        'ELECTIONCOMMISSION', 'ELECTORAL', 'ELECTORSPHOTO', 'EPIC', 'VOTERID',
    ],
};

// Nothing generic is left in the strong lists — "Government of India", "Bharat
// Sarkar" and "Identity Card" moved to SUPPORTING_TOKENS below, because they are
// on every Indian document and are one line of typing away in a forgery. A
// strong keyword has to be distinctive enough that reading it means something.
const AMBIGUOUS = new Set();

// ─── OCR-tolerant text matching ──────────────────────────────────────────────
// Tesseract confuses whole families of glyphs on a photographed card. Folding
// each family to one representative — on BOTH the OCR text and the expected
// value — means a card read as "8O12" still matches the typed "8012" without
// loosening anything else.
const CONFUSION = {
    O: '0', D: '0', Q: '0',
    I: '1', L: '1',
    Z: '2',
    S: '5',
    G: '6',
    B: '8',
    T: '7',
};

const fold = (value) =>
    String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .replace(/[ODQILZSGBT]/g, (ch) => CONFUSION[ch]);

/**
 * Approximate substring search: is `needle` present in `haystack` within
 * `maxDist` edits? Levenshtein with a free start and a free end, so a dropped or
 * hallucinated character mid-number does not sink an otherwise clean read.
 */
const approxContains = (haystack, needle, maxDist) => {
    if (!needle) return false;
    if (maxDist <= 0) return haystack.includes(needle);
    if (haystack.length < needle.length - maxDist) return false;

    // Row 0 is all zeros: the match may start anywhere in the haystack.
    let prev = new Array(haystack.length + 1).fill(0);
    for (let i = 1; i <= needle.length; i += 1) {
        const cur = new Array(haystack.length + 1);
        cur[0] = i;
        for (let j = 1; j <= haystack.length; j += 1) {
            const cost = needle[i - 1] === haystack[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        prev = cur;
    }
    // The match may end anywhere: take the best cell in the final row.
    let best = Infinity;
    for (let j = 0; j < prev.length; j += 1) if (prev[j] < best) best = prev[j];
    return best <= maxDist;
};

// Longer values earn more slack; a 7-character passport number gets one slip,
// a 12-digit Aadhaar two.
const toleranceFor = (value) => Math.floor(value.length / 6);

const findNumber = (foldedText, idNumber) => {
    const target = fold(idNumber);
    if (target.length < 6) return false;
    return approxContains(foldedText, target, toleranceFor(target));
};

// A stricter read of the same number, for the supporting-evidence path below:
// weaker evidence about the document demands a stronger match on the number.
const findNumberStrict = (foldedText, idNumber) => {
    const target = fold(idNumber);
    if (target.length < 6) return false;
    return approxContains(foldedText, target, 1);
};

// One slip allowed from six characters up. "AADHAAR" is seven and is the single
// most important token on the card — demanding it letter-perfect off a phone
// photo was throwing away genuine cards. Shorter tokens (EPIC, DLNO, UIDAI) are
// too easy to hit by accident to fuzz at all.
const keywordTolerance = (target) => (target.length >= 6 ? 1 : 0);

const findKeyword = (foldedText, keywords) =>
    keywords.some((kw) => {
        const target = fold(kw);
        return approxContains(foldedText, target, keywordTolerance(target));
    });

// ─── Supporting evidence ─────────────────────────────────────────────────────
// Words that are typical of a document without being proof of it. On their own
// they mean nothing. Two or more of them, PLUS the full ID number read off the
// image with at most one character wrong, is enough — that combination is not
// something a screenshot of the digits in a text editor produces.
// Deliberately NOT "India", "Govt" or "Card": those appear on every Indian
// document and in any text someone types to imitate one, which would make this
// tier a way in rather than a safety net.
const SUPPORTING_TOKENS = {
    'Aadhaar Card': ['DOB', 'YEAROFBIRTH', 'ENROLMENT', 'ENROLLMENT', 'VID',
        'AUTHORITY', 'IDENTIFICATION', 'MALE', 'FEMALE', 'ADDRESS',
        'GOVERNMENTOFINDIA', 'GOVTOFINDIA', 'BHARATSARKAR'],
    'PAN Card': ['INCOME', 'DEPARTMENT', 'PERMANENT', 'ACCOUNT', 'SIGNATURE',
        'FATHER', 'GOVTOFINDIA', 'GOVERNMENTOFINDIA'],
    'Driving License': ['LICENCE', 'LICENSE', 'TRANSPORT', 'VALIDTILL', 'BLOODGROUP',
        'MOTORVEHICLE', 'AUTHORISATION'],
    'Passport': ['REPUBLIC', 'NATIONALITY', 'PLACEOFISSUE', 'DATEOFISSUE',
        'SURNAME', 'GIVENNAME', 'HOLDER'],
    'Voter ID': ['ELECTION', 'ELECTOR', 'COMMISSION', 'IDENTITY', 'PHOTO', 'IDENTITYCARD'],
};

const countSupport = (foldedText, idType) =>
    (SUPPORTING_TOKENS[idType] || []).filter((tok) => {
        const target = fold(tok);
        return approxContains(foldedText, target, keywordTolerance(target));
    }).length;

/**
 * A masked Aadhaar prints eight X's and the last four digits. Matching that
 * exact shape — not merely "the last four appear somewhere" — is what keeps
 * this from being a hole: a random page containing those digits will not also
 * contain them behind an eight-character mask.
 */
const findMaskedNumber = (maskedText, idNumber) => {
    const digits = String(idNumber || '').replace(/\D/g, '');
    if (digits.length !== 12) return false;
    const target = 'XXXXXXXX' + fold(digits.slice(-4));
    return approxContains(maskedText, target, 2);
};

/** Which document does this text look like, ignoring what the user selected? */
const detectType = (foldedText) => {
    for (const [type, keywords] of Object.entries(ID_KEYWORDS)) {
        const distinctive = keywords.filter((kw) => !AMBIGUOUS.has(kw));
        if (findKeyword(foldedText, distinctive)) return type;
    }
    return '';
};

/**
 * Score one block of OCR text against what the submitter claimed.
 * Pure — no I/O — so the CLI self-test and the unit tests exercise exactly the
 * logic the server runs.
 */
const evaluateText = (text, idType, idNumber) => {
    const upper = String(text || '').toUpperCase();
    const foldedText = fold(upper);
    // fold() drops everything non-alphanumeric and X survives it, which is
    // exactly the shape the masked-Aadhaar check looks for.
    const maskedText = fold(upper.replace(/[*•×]/g, 'X'));

    const keywords = ID_KEYWORDS[idType] || [];
    const keywordFound = findKeyword(foldedText, keywords);
    const numberFound = findNumber(foldedText, idNumber);
    const maskedFound =
        ALLOW_MASKED && idType === 'Aadhaar Card' && findMaskedNumber(maskedText, idNumber);
    const support = countSupport(foldedText, idType);

    // Two ways to pass:
    //   1. a keyword that names the document, plus the number (or a genuine mask).
    //   2. no keyword survived the photo, but the full number is there AND at
    //      least two supporting words are — a poorly-lit card, not a forgery.
    const strongMatch = keywordFound && (numberFound || maskedFound);
    const supportedMatch = !strongMatch && support >= 2 && findNumberStrict(foldedText, idNumber);

    return {
        keywordFound,
        numberFound,
        maskedFound,
        support,
        supportedMatch,
        matched: strongMatch || supportedMatch,
        detectedType: keywordFound ? idType : detectType(foldedText),
        chars: String(text || '').length,
    };
};

// ─── Render passes ───────────────────────────────────────────────────────────
// Cloudinary already holds the document, so it can do the image preparation OCR
// needs (upscale, greyscale, sharpen, and page-1 rasterisation for PDFs) without
// this service growing a native image dependency. Each pass is tried in turn and
// the first one that matches wins.
//
// `source: 'raw'` is the URL Cloudinary itself returned at upload. It carries no
// transformation and no rebuilt signature, so it is the pass most likely to work
// when the account restricts derived assets — which is exactly the case where
// everything else 401s and the check silently goes quiet.
// `crop: 'scale'`, NOT 'limit'. c_limit only ever shrinks — it will not enlarge
// a small image, so a WhatsApp-compressed or cropped photo was being OCR'd at
// its original postage-stamp size and read as a handful of characters. Tesseract
// wants roughly 30px of height per character; scaling up is the single biggest
// lever on a phone photo of a card.
//
// Zoom tiles. A screenshot is the common failure: the card is a small strip in
// the middle of a 1920px screen capture (browser chrome, chat window, taskbar
// all around it), so the card's own text is 8–10px tall. Scaling the WHOLE
// image to 2400px is only 1.25x on a screenshot that is already 1920 wide, and
// the text stays unreadable. Cropping to a 55–60% region first and then scaling
// that region to 2600px gives 2.5x on the card itself. Five tiles (centre and
// the four corners) cover any placement; the OCR text of all of them is pooled
// with the other passes, so the keyword may come from one tile and the number
// from another. Tiles do not retry other segmentation modes — most of them are
// mostly empty and a retry would spend the time budget on nothing.
const zoomTile = (name, gravity, fraction) => ({
    name: `zoom-${name}`,
    source: 'derived',
    transformation: [
        { crop: 'crop', width: fraction, height: fraction, gravity },
        { width: 2600, crop: 'scale' },
        { effect: 'sharpen:120' },
        { quality: 'auto:best' },
    ],
    psm: PSM.AUTO,
    retry: false,
});

// Rotated renders. Tesseract has no idea the page is upside-down: a card
// photographed or saved rotated 180° reads as 1800 characters of confident
// nonsense (`L8L1 ¥9L0 L098` is `8607 0764 1787` the wrong way up) and matches
// nothing. Cloudinary rotates the render; 180° first because it is by far the
// most common wrong orientation, then the two portrait cases. No PSM retries —
// a rotation that is wrong reads just as much text as one that is right, so a
// thin read is not the signal here.
const rotated = (angle, extra = []) => ({
    name: `rot${angle}`,
    source: 'derived',
    transformation: [
        ...extra,
        { width: 2400, crop: 'scale' },
        { angle },
        { effect: 'sharpen:120' },
        { quality: 'auto:best' },
    ],
    psm: PSM.AUTO,
    retry: false,
});

const RENDER_PASSES = [
    {
        name: 'upscaled',
        source: 'derived',
        transformation: [
            { width: 2400, crop: 'scale' },
            { effect: 'sharpen:120' },
            { quality: 'auto:best' },
        ],
        psm: PSM.AUTO,
    },
    // Centre first: a card is usually placed in the middle of a screenshot, and
    // this one tile alone read the heading, the number and seven supporting
    // words off a WhatsApp-Web screenshot that every full-image pass failed on.
    zoomTile('center', 'center', 0.6),
    rotated(180),
    rotated(90),
    rotated(270),
    // A rotated screenshot: centre tile, then turned the right way up.
    { ...rotated(180, [{ crop: 'crop', width: 0.6, height: 0.6, gravity: 'center' }]), name: 'zoom-center-rot180' },
    zoomTile('sw', 'south_west', 0.55),
    zoomTile('se', 'south_east', 0.55),
    zoomTile('nw', 'north_west', 0.55),
    zoomTile('ne', 'north_east', 0.55),
    {
        name: 'binarised',
        source: 'derived',
        transformation: [
            { width: 2400, crop: 'scale' },
            { effect: 'grayscale' },
            { effect: 'auto_contrast' },
            { effect: 'blackwhite:42' },
            { quality: 'auto:best' },
        ],
        psm: PSM.AUTO,
    },
    {
        name: 'high-contrast',
        source: 'derived',
        transformation: [
            { width: 3000, crop: 'scale' },
            { effect: 'grayscale' },
            { effect: 'contrast:40' },
            { effect: 'sharpen:300' },
            { quality: 'auto:best' },
        ],
        psm: PSM.SPARSE_TEXT,
    },
    { name: 'signed-original', source: 'derived', transformation: null, psm: PSM.AUTO },
    { name: 'upload-url', source: 'raw', transformation: null, psm: PSM.AUTO },
];

// Re-run on bytes already downloaded when nothing has matched yet. A card is a
// multi-column layout with a photo in it, and the segmentation mode changes what
// Tesseract even attempts to read — cheap to retry, no second download.
const RETRY_PSMS = [PSM.SPARSE_TEXT, PSM.SINGLE_COLUMN].filter(Boolean);

const fetchBytes = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
};

const ocrBuffer = (buffer, psm) =>
    withWorker(async (worker) => {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        const result = await worker.recognize(buffer);
        return result?.data?.text || '';
    });

// ─── Messages ────────────────────────────────────────────────────────────────
// Said to the submitter, so they say what to do next.
const MESSAGES = {
    'wrong-type': (selected, detected) =>
        `The document you uploaded looks like a ${detected}, but you selected ${selected}. ` +
        'Please pick the matching ID type, or upload the document you selected.',
    'no-keyword': (selected) =>
        `We could not recognise that image as a ${selected}. Please upload a clear photo or scan of the ` +
        'whole document — all four corners visible, in focus, and not cropped.',
    'no-number': (selected) =>
        `We could not find your ${selected} number on the document you uploaded. The number you type must ` +
        'match the number printed on the card exactly, and it must be sharp and unobscured in the photo.',
    unreadable:
        'We could not read any text in that file. Please upload a clear, well-lit photo or scan of your ID — ' +
        'PNG, JPG, or PDF, under 10MB.',
    unavailable:
        'We could not check your ID document just now, so the review was not submitted. Please try again in ' +
        'a moment, or upload a different photo of your ID.',
};

/**
 * Verify an uploaded ID proof.
 *
 * @param {object} args
 * @param {object} args.assetRef  Cloudinary reference; lets us request prepared renders.
 * @param {string} args.imageUrl  Signed URL rebuilt from the reference.
 * @param {string} args.rawUrl    The URL Cloudinary returned at upload. Last-resort pass.
 * @param {string} args.mimetype  Client-declared, for PDF detection only — never trusted alone.
 * @param {string} args.idType    The type the submitter selected.
 * @param {string} args.idNumber  The number the submitter typed (plaintext).
 * @returns {Promise<{decision:'verified'|'rejected'|'pending', reason:string, message:string,
 *                    numberFound:boolean, keywordFound:boolean, detectedType:string}>}
 */
async function verifyIdProof({ assetRef, imageUrl, rawUrl, mimetype, idType, idNumber }) {
    const started = Date.now();

    if (!ID_KEYWORDS[idType]) {
        return {
            decision: 'rejected', reason: 'unknown-type',
            message: 'Please select a valid ID type.',
            numberFound: false, keywordFound: false, detectedType: '',
        };
    }

    const isPdf =
        String(assetRef?.format || '').toLowerCase() === 'pdf' ||
        String(mimetype || '').toLowerCase() === 'application/pdf' ||
        /\.pdf(\?|$)/i.test(imageUrl || rawUrl || '');

    // A PDF is rasterised to page 1 as JPEG, which is the only way Tesseract sees
    // it at all — skipping PDFs outright is what made "upload a PDF" the way
    // around the check.
    const urlForPass = (pass) => {
        if (pass.source === 'raw') return rawUrl || '';
        if (!assetRef || !assetRef.publicId) return imageUrl || '';
        const transformation = [...(pass.transformation || [])];
        if (isPdf) transformation.unshift({ page: 1 });
        const opts = {};
        if (transformation.length) opts.transformation = transformation;
        if (isPdf || transformation.length) opts.format = 'jpg';
        return signedAssetUrl(assetRef, opts) || imageUrl || '';
    };

    let sawAnyText = false;
    let scored = null;
    // Every pass reads a different part of the card well. Judging each render in
    // isolation threw that away: the keyword could be legible in one pass and the
    // number in another, and neither would match on its own. They are pooled and
    // scored together instead.
    let combinedText = '';
    const failures = [];
    const tried = new Set();
    // One line per pass, returned to the caller so a rejection can be diagnosed
    // from the API response (outside production) without the server log.
    const attempts = [];

    // What went back to the caller. `sample` is the start of the pooled OCR
    // text — it is text off someone's ID document, and the controller only
    // exposes it outside production.
    const diagnostics = () => ({
        charsRead: combinedText.trim().length,
        support: scored ? scored.support : 0,
        sample: combinedText.replace(/\s+/g, ' ').trim().slice(0, 300),
        attempts,
    });

    const consider = (text, label) => {
        if (text && text.trim()) combinedText += `\n${text}`;
        sawAnyText = sawAnyText || Boolean(text && text.trim());
        scored = evaluateText(combinedText, idType, idNumber);
        attempts.push(
            `${label} chars=${(text || '').length} keyword=${scored.keywordFound} ` +
            `number=${scored.numberFound} support=${scored.support}`
        );
        console.log(
            `[id-verify] ${label} type=${idType} keyword=${scored.keywordFound} ` +
            `number=${scored.numberFound} masked=${scored.maskedFound} support=${scored.support} ` +
            `chars=${(text || '').length} pooled=${combinedText.length}`
        );
        if (DEBUG_OCR_TEXT) {
            console.log(`[id-verify][DEBUG] ${label} read:`, String(text || '').replace(/\s+/g, ' ').slice(0, 400));
        }
        return scored.matched;
    };

    for (const pass of RENDER_PASSES) {
        if (Date.now() - started > TOTAL_BUDGET_MS) {
            failures.push(`${pass.name}: budget exhausted`);
            attempts.push(`pass=${pass.name} skipped: time budget exhausted`);
            break;
        }

        const url = urlForPass(pass);
        // The raw upload URL and the rebuilt signed URL are often identical —
        // no reason to download and OCR the same bytes twice.
        if (!url || tried.has(url)) continue;
        tried.add(url);

        let buf;
        try {
            buf = await fetchBytes(url);
        } catch (err) {
            // Derived URLs 401 on accounts with strict transformations, and PDF
            // delivery is off by default on some Cloudinary plans. Log the status
            // — when every pass fails, this line is the diagnosis.
            failures.push(`${pass.name}: fetch ${err.message}`);
            attempts.push(`pass=${pass.name} fetch failed: ${err.message}`);
            console.warn(`[id-verify] pass=${pass.name} fetch failed: ${err.message}`);
            continue;
        }

        const format = sniffFormat(buf);
        if (format === 'pdf' || format === 'unknown') {
            failures.push(`${pass.name}: got ${format}, not a raster image`);
            attempts.push(`pass=${pass.name} got ${format}, not a raster image`);
            console.warn(`[id-verify] pass=${pass.name} sniffed=${format} — cannot OCR, trying next pass`);
            continue;
        }

        const psms = pass.retry === false
            ? [pass.psm]
            : [pass.psm, ...RETRY_PSMS.filter((p) => p !== pass.psm)];
        let matched = false;

        for (const psm of psms) {
            if (Date.now() - started > TOTAL_BUDGET_MS) break;

            let text;
            try {
                text = await ocrBuffer(buf, psm);
            } catch (err) {
                failures.push(`${pass.name}/psm${psm}: OCR ${err.message}`);
                attempts.push(`pass=${pass.name} psm=${psm} OCR failed: ${err.message}`);
                console.error(`[id-verify] pass=${pass.name} psm=${psm} OCR failed: ${err.message}`);
                continue;
            }

            if (consider(text, `pass=${pass.name} psm=${psm}`)) { matched = true; break; }

            // Only re-segment the same bytes while we are still short of a match
            // and the first read was thin — a good read that simply does not match
            // is not going to be rescued by another segmentation mode.
            if (text.trim().length > 400) break;
        }

        if (matched) {
            const reason = scored.supportedMatch
                ? 'match-supporting'
                : (scored.numberFound ? 'match' : 'match-masked');
            if (reason === 'match-masked') console.log('[id-verify] masked Aadhaar accepted (last four matched)');
            if (reason === 'match-supporting') {
                console.log(`[id-verify] accepted on the number plus ${scored.support} supporting words`);
            }
            return {
                decision: 'verified', reason, message: '',
                numberFound: scored.numberFound, keywordFound: scored.keywordFound, detectedType: idType,
                ...diagnostics(),
            };
        }
    }

    // ── Could not check at all ───────────────────────────────────────────────
    // Not a verdict on the document: every pass failed before OCR ran. This must
    // NOT pass — "we could not look" is not "it is fine". It is loud in the log
    // because if it happens to everyone, it is a Cloudinary delivery problem, not
    // a user problem.
    if (!sawAnyText) {
        console.error(
            `[id-verify] UNAVAILABLE — no pass produced readable bytes for a ${idType}. ` +
            `Attempts: ${failures.join(' | ') || 'none'}`
        );
        const unavailableReason = isPdf ? 'pdf-render-failed' : 'verify-unavailable';
        return {
            decision: ON_ERROR === 'pending' || MODE === 'advisory' ? 'pending' : 'rejected',
            reason: unavailableReason,
            message: MESSAGES.unavailable,
            numberFound: false, keywordFound: false, detectedType: '',
            ...diagnostics(),
        };
    }

    // ── Read it, and it does not match ───────────────────────────────────────
    if (!scored) scored = evaluateText(combinedText, idType, idNumber);

    let reason;
    let message;
    // Barely any text came back across every render and every segmentation mode.
    // That is a picture problem, not a mismatch — say so, because "we could not
    // recognise this as an Aadhaar card" sends someone hunting for the wrong fault.
    if (combinedText.trim().length < 60) {
        reason = 'unreadable';
        message = MESSAGES.unreadable;
    } else if (scored.detectedType && scored.detectedType !== idType) {
        reason = 'wrong-type';
        message = MESSAGES['wrong-type'](idType, scored.detectedType);
    } else if (!scored.keywordFound) {
        reason = 'no-keyword';
        message = MESSAGES['no-keyword'](idType);
    } else {
        reason = 'no-number';
        message = MESSAGES['no-number'](idType);
    }

    console.log(
        `[id-verify] REJECT type=${idType} reason=${reason} detected=${scored.detectedType || 'n/a'} ` +
        `support=${scored.support} pooled=${combinedText.length} chars. ` +
        'Set ID_VERIFY_DEBUG_OCR=true to see what was read.'
    );

    return {
        decision: MODE === 'advisory' ? 'pending' : 'rejected',
        reason,
        message,
        numberFound: scored.numberFound,
        keywordFound: scored.keywordFound,
        detectedType: scored.detectedType,
        ...diagnostics(),
    };
}

/**
 * Run the same check against a local file. Used by scripts/testIdVerify.js so
 * OCR can be proved out without Cloudinary in the way.
 */
async function verifyLocalFile(filePath, idType, idNumber) {
    const fs = require('fs/promises');
    const buf = await fs.readFile(filePath);
    const format = sniffFormat(buf);
    if (format === 'pdf' || format === 'unknown') {
        return { error: `${filePath} is a ${format} — this check needs a PNG, JPG or GIF.` };
    }

    // No Cloudinary here, so the render passes cannot be applied — the same
    // bytes are read once per distinct segmentation mode instead.
    const attempts = [];
    const psms = [...new Set([PSM.AUTO, ...RETRY_PSMS])];
    for (const psm of psms) {
        const text = await ocrBuffer(buf, psm);
        attempts.push({ pass: `psm=${psm}`, text, ...evaluateText(text, idType, idNumber) });
        if (attempts[attempts.length - 1].matched) break;
    }
    return { attempts, matched: attempts.some((a) => a.matched) };
}

module.exports = {
    verifyIdProof,
    verifyLocalFile,
    evaluateText,
    shutdownOcr,
    // Exported for the unit tests.
    fold,
    approxContains,
    findNumber,
    findKeyword,
    findMaskedNumber,
    detectType,
    sniffFormat,
    ID_KEYWORDS,
    MODE,
    ON_ERROR,
};
