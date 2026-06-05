// // utils/verifyId.js
// // ─────────────────────────────────────────────────────────────────────────
// // Best-effort automated check of an uploaded ID proof using OCR (Tesseract).
// // It reads the text out of the uploaded image and checks whether it contains
// // (a) the ID number the user typed and (b) keywords expected for that ID type.
// //
// //   • Random / unrelated photo  → neither found            → REJECT
// //   • Looks like the right doc  → number AND keyword found  → auto-verify
// //   • Partial / unclear         → one of them found         → accept, mark for
// //                                                             manual review
// //   • PDF or OCR error          → can't check               → accept, manual review
// //
// // NOTE: OCR is a heuristic, not proof of authenticity. It blocks obvious fakes
// // but a human (or a real KYC provider) should confirm genuine ones.
// // ─────────────────────────────────────────────────────────────────────────

// const Tesseract = require('tesseract.js');

// const ID_KEYWORDS = {
//     'Aadhaar Card': ['AADHAAR', 'UIDAI', 'UNIQUE IDENTIFICATION', 'GOVERNMENT OF INDIA', 'VID'],
//     'PAN Card': ['INCOME TAX', 'PERMANENT ACCOUNT NUMBER', 'PAN'],
//     'Driving License': ['DRIVING LICENCE', 'DRIVING LICENSE', 'TRANSPORT', 'LICENCE', 'DL NO'],
//     'Passport': ['PASSPORT', 'REPUBLIC OF INDIA'],
//     'Voter ID': ['ELECTION COMMISSION', 'ELECTORAL', 'EPIC', 'IDENTITY CARD'],
// };

// /**
//  * @param {object} args
//  * @param {string} args.imageUrl  Cloudinary (or any) URL of the uploaded proof
//  * @param {string} [args.mimetype]
//  * @param {string} args.idType
//  * @param {string} args.idNumber
//  * @returns {Promise<{ok:boolean, autoVerified:boolean, reason:string, numberFound:boolean, keywordFound:boolean}>}
//  */
// async function verifyIdProof({ imageUrl, mimetype, idType, idNumber }) {
//     // Tesseract can't OCR PDFs — skip the automated check, leave for manual review
//     if (mimetype === 'application/pdf' || /\.pdf(\?|$)/i.test(imageUrl || '')) {
//         return { ok: true, autoVerified: false, reason: 'pdf-skip', numberFound: false, keywordFound: false };
//     }

//     let text = '';
//     try {
//         // Fetch the image to a Buffer (more reliable in Node than passing a URL)
//         const res = await fetch(imageUrl);
//         if (!res.ok) throw new Error('could not download proof image');
//         const buf = Buffer.from(await res.arrayBuffer());

//         const result = await Tesseract.recognize(buf, 'eng');
//         text = (result?.data?.text || '').toUpperCase();
//     } catch (err) {
//         // Technical failure → don't punish the user; accept for manual review
//         console.error('ID OCR failed:', err.message);
//         return { ok: true, autoVerified: false, reason: 'ocr-error', numberFound: false, keywordFound: false };
//     }

//     const cleanText = text.replace(/[\s-]/g, '');
//     const cleanNumber = String(idNumber || '').replace(/[\s-]/g, '').toUpperCase();

//     const numberFound = cleanNumber.length >= 6 && cleanText.includes(cleanNumber);
//     const keywords = ID_KEYWORDS[idType] || [];
//     const keywordFound = keywords.some((k) => text.includes(k));

//     // Random/unrelated photo: contains neither the number nor any document keyword
//     if (!numberFound && !keywordFound) {
//         return { ok: false, autoVerified: false, reason: 'no-match', numberFound, keywordFound };
//     }

//     // Both present → strong match (auto-verify). One present → accept, manual review.
//     return {
//         ok: true,
//         autoVerified: numberFound && keywordFound,
//         reason: 'match',
//         numberFound,
//         keywordFound,
//     };
// }

// module.exports = { verifyIdProof };








// utils/verifyId.js
// ─────────────────────────────────────────────────────────────────────────
// Automated (best-effort) check of an uploaded ID proof using OCR (Tesseract).
//
// IMPORTANT: OCR is unreliable on real Indian IDs (Aadhaar's Hindi+English text,
// glare, low contrast), so we DO NOT hard-reject by default — a genuine card the
// OCR misreads must still get through. Instead:
//
//   • number clearly read off the image      → auto-verify (verified: true)
//   • only a document keyword found, or OCR
//     couldn't read it, or it's a PDF         → accept, mark PENDING (verified:false)
//   • neither found                           → accept, mark PENDING (still not blocked)
//
//   Pending ones go to manual review. Set STRICT = true if you'd rather REJECT
//   uploads that fail the automated check (warning: this can block real cards
//   whose photo OCR can't read).
// ─────────────────────────────────────────────────────────────────────────

const Tesseract = require('tesseract.js');

// Flip to true to block submissions that fail the OCR check (stricter, but
// will sometimes reject genuine cards with poor-quality photos).
const STRICT = false;

const ID_KEYWORDS = {
    'Aadhaar Card': ['AADHAAR', 'AADHAR', 'ADHAAR', 'UIDAI', 'UNIQUEIDENTIFICATION', 'GOVERNMENTOFINDIA', 'MERAAADHAAR'],
    'PAN Card': ['INCOMETAX', 'PERMANENTACCOUNTNUMBER', 'INCOMETAXDEPARTMENT'],
    'Driving License': ['DRIVINGLICENCE', 'DRIVINGLICENSE', 'TRANSPORT', 'LICENCE', 'DLNO'],
    'Passport': ['PASSPORT', 'REPUBLICOFINDIA'],
    'Voter ID': ['ELECTIONCOMMISSION', 'ELECTORAL', 'EPIC', 'IDENTITYCARD'],
};

async function verifyIdProof({ imageUrl, mimetype, idType, idNumber }) {
    // Tesseract can't OCR PDFs → accept, leave for manual review
    if (mimetype === 'application/pdf' || /\.pdf(\?|$)/i.test(imageUrl || '')) {
        console.log('[id-verify] PDF upload — skipping OCR, marking pending review.');
        return { ok: true, autoVerified: false, reason: 'pdf-skip', numberFound: false, keywordFound: false };
    }

    let text = '';
    try {
        const res = await fetch(imageUrl);
        if (!res.ok) throw new Error('could not download proof image (' + res.status + ')');
        const buf = Buffer.from(await res.arrayBuffer());
        const result = await Tesseract.recognize(buf, 'eng');
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

    // Debug — see exactly what OCR read and what matched
    console.log(`[id-verify] type=${idType} numberFound=${numberFound} keywordFound=${keywordFound}`);
    console.log('[id-verify] OCR text (first 300 chars):', text.replace(/\n/g, ' ').slice(0, 300));

    if (!numberFound && !keywordFound) {
        // Couldn't recognise it. Block only in STRICT mode; otherwise accept as pending.
        return { ok: !STRICT, autoVerified: false, reason: 'no-match', numberFound, keywordFound };
    }

    // Strong signal if the typed number was actually read off the card → auto-verify.
    return {
        ok: true,
        autoVerified: numberFound,
        reason: 'match',
        numberFound,
        keywordFound,
    };
}

module.exports = { verifyIdProof };