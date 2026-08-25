// utils/verifyId.js
// ─────────────────────────────────────────────────────────────────────────
// Automated (best-effort) check of an uploaded ID proof using OCR (Tesseract).
//
// IMPORTANT: OCR is unreliable on real Indian IDs (Aadhaar's Hindi+English text,
// glare, low contrast), so we DO NOT hard-reject by default — a genuine card the
// OCR misreads must still get through. Instead:
//
//   • number AND a document keyword read
//     off the image                           → auto-verify (verified: true)
//   • only one of the two found, or OCR
//     couldn't read it, or it's a PDF         → accept, mark PENDING (verified:false)
//   • neither found                           → accept, mark PENDING (still not blocked)
//
//   POLICY: accept as pending, never hard-reject. `ok` is true on every path and
//   the caller ignores it; the meaningful outputs are `autoVerified` and `reason`,
//   which the controller stores so the pending pile can be sorted for manual
//   review. A number-only match is deliberately NOT enough to auto-verify (a
//   screenshot of a Notepad window containing the digits would pass).
// ─────────────────────────────────────────────────────────────────────────

const Tesseract = require('tesseract.js');

// Flip to true to block submissions that fail the OCR check (stricter, but
// will sometimes reject genuine cards with poor-quality photos).
// NOTE: the caller currently ignores `ok` entirely — the policy is "accept as
// pending, never hard-reject" — so this only matters if that policy changes.
const STRICT = false;

// A hung Cloudinary/CDN fetch used to hold the whole request open forever.
const FETCH_TIMEOUT_MS = 10000;

// ── Raw OCR text logging — OFF by default, and it must stay that way ─────
// The recognised text of a government ID contains the holder's name, date of
// birth and ID number. Printing it puts all three into the log stream in plain
// text, where they are retained, shipped to whatever aggregator is attached, and
// readable by anyone with log access — which is a much wider group than anyone
// who can reach the document itself.
//
// Set ID_VERIFY_DEBUG_OCR=true ONLY on a local machine, against test documents
// you own, while tuning ID_KEYWORDS. Never in a deployed environment.
const DEBUG_OCR_TEXT = process.env.ID_VERIFY_DEBUG_OCR === 'true';

if (DEBUG_OCR_TEXT) {
    console.warn(
        '⚠️  ID_VERIFY_DEBUG_OCR=true — the full OCR text of every ID proof (name, DOB, ID number) ' +
        'is being written to the log. Unset this outside local development.'
    );
}

// ── OCR concurrency cap ──────────────────────────────────────────────────
// Tesseract spawns a worker (and loads the language data) per recognize() call.
// 20 simultaneous submissions used to spawn 20 workers and exhaust the
// container, so recognitions beyond MAX_CONCURRENT_OCR queue up here instead.
// In-process only: a multi-instance deploy gets this cap per instance.
const MAX_CONCURRENT_OCR = 2;
let activeOcr = 0;
const ocrQueue = [];

const acquireOcrSlot = () =>
    new Promise((resolve) => {
        if (activeOcr < MAX_CONCURRENT_OCR) {
            activeOcr += 1;
            resolve();
        } else {
            ocrQueue.push(resolve);
        }
    });

const releaseOcrSlot = () => {
    const next = ocrQueue.shift();
    // Hand the slot straight to the next waiter (activeOcr stays the same),
    // otherwise give it back to the pool.
    if (next) next();
    else activeOcr = Math.max(0, activeOcr - 1);
};

const runOcr = async (buffer) => {
    await acquireOcrSlot();
    try {
        return await Tesseract.recognize(buffer, 'eng');
    } finally {
        releaseOcrSlot();
    }
};

// ── Content sniffing ─────────────────────────────────────────────────────
// The client-declared mimetype is a single header and therefore a one-header
// bypass (send a JPEG as application/pdf and OCR is skipped). Decide from the
// bytes we actually downloaded instead.
const sniffFormat = (buf) => {
    if (!buf || buf.length < 4) return 'unknown';
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';   // %PDF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';                     // FF D8 FF
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';   // \x89PNG
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';   // GIF8
    return 'unknown';
};

const ID_KEYWORDS = {
    'Aadhaar Card': ['AADHAAR', 'AADHAR', 'ADHAAR', 'UIDAI', 'UNIQUEIDENTIFICATION', 'GOVERNMENTOFINDIA', 'MERAAADHAAR'],
    'PAN Card': ['INCOMETAX', 'PERMANENTACCOUNTNUMBER', 'INCOMETAXDEPARTMENT'],
    'Driving License': ['DRIVINGLICENCE', 'DRIVINGLICENSE', 'TRANSPORT', 'LICENCE', 'DLNO'],
    'Passport': ['PASSPORT', 'REPUBLICOFINDIA'],
    'Voter ID': ['ELECTIONCOMMISSION', 'ELECTORAL', 'EPIC', 'IDENTITYCARD'],
};

// `mimetype` is accepted for logging only — it is client-supplied and is NEVER
// used to decide whether to run OCR (see sniffFormat above).
async function verifyIdProof({ imageUrl, mimetype, idType, idNumber }) {
    // Secondary signal only: used to disambiguate bytes we can't identify.
    const pdfUrlHint = /\.pdf(\?|$)/i.test(imageUrl || '');

    let buf;
    try {
        const res = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error('could not download proof image (' + res.status + ')');
        buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        console.error('[id-verify] proof download failed:', err.message);
        return { ok: true, autoVerified: false, reason: 'fetch-error', numberFound: false, keywordFound: false };
    }

    const format = sniffFormat(buf);
    if (format !== 'jpeg' && format !== 'png' && format !== 'gif') {
        // Tesseract can't OCR PDFs (or anything we can't identify) → accept, leave
        // for manual review. Declared mimetype logged purely for diagnostics.
        const reason = format === 'pdf' || pdfUrlHint ? 'pdf-skip' : 'unsupported-format';
        console.log(`[id-verify] sniffed=${format} declared=${mimetype || 'n/a'} — skipping OCR (${reason}), marking pending review.`);
        return { ok: true, autoVerified: false, reason, numberFound: false, keywordFound: false };
    }

    let text = '';
    try {
        const result = await runOcr(buf);
        text = result?.data?.text || '';
    } catch (err) {
        console.error('[id-verify] OCR failed:', err.message);
        return { ok: true, autoVerified: false, reason: 'ocr-error', numberFound: false, keywordFound: false };
    }

    const upper = text.toUpperCase();

    // Number match — compare alphanumerics only, ignoring all OCR noise/spacing
    const alnumText = upper.replace(/[^A-Z0-9]/g, '');
    const alnumNumber = String(idNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const numberFound = alnumNumber.length >= 6 && alnumText.includes(alnumNumber);

    // Keyword match — compare with spaces removed so "AADHAAR" matches "A A D H A A R"-style spacing
    const compactText = upper.replace(/\s/g, '');
    const keywords = ID_KEYWORDS[idType] || [];
    const keywordFound = keywords.some((k) => compactText.includes(k));

    // Diagnostics. The booleans and the ID type are safe to log; the OCR text is
    // NOT — on a legible card it is the holder's full name, date of birth and ID
    // number, and logging it wrote all three into the platform log stream (and
    // anywhere those logs are shipped or retained) on every single submission.
    // That is precisely the data `select: false` and authenticated Cloudinary
    // delivery exist to protect, handed over in plain text at the last step.
    //
    // What actually helps when tuning ID_KEYWORDS is knowing whether the text was
    // read at all and how much of it, which the length gives without the content.
    console.log(
        `[id-verify] type=${idType} numberFound=${numberFound} keywordFound=${keywordFound} chars=${text.length}`
    );

    if (DEBUG_OCR_TEXT) {
        // Local tuning only — see the DEBUG_OCR_TEXT note at the top of this file.
        console.log('[id-verify][DEBUG] OCR text (first 300 chars):', text.replace(/\n/g, ' ').slice(0, 300));
    }

    if (!numberFound && !keywordFound) {
        // Couldn't recognise it → accept as pending. `ok` is left wired to STRICT so
        // the knob still means something if the policy is ever revisited, but the
        // controller deliberately ignores `ok` today (accept-as-pending policy), so
        // flipping STRICT alone will NOT start rejecting uploads.
        return { ok: !STRICT, autoVerified: false, reason: 'no-match', numberFound, keywordFound };
    }

    // Auto-verify ONLY when the typed number AND a document keyword were both read
    // off the image. A number-only match (e.g. a screenshot of a Notepad window
    // containing the digits) must stay pending.
    return {
        ok: true,
        autoVerified: numberFound && keywordFound,
        reason: 'match',
        numberFound,
        keywordFound,
    };
}

module.exports = { verifyIdProof };