#!/usr/bin/env node
/**
 * Run the ID check against a local image, with Cloudinary out of the picture.
 *
 *   node src/scripts/testIdVerify.js ./my-aadhaar.jpg "Aadhaar Card" 234567890124
 *
 * Prints what OCR actually read and what the matcher made of it. Use this to
 * tell the two failure modes apart:
 *
 *   - matcher says NO MATCH here too  → the photo genuinely is not readable, or
 *                                       the number does not appear on it.
 *   - matcher says MATCH here, but the
 *     server still rejects              → the server cannot fetch the document
 *                                       from Cloudinary. Look for the
 *                                       `[id-verify] UNAVAILABLE` line in the
 *                                       server log; it lists what each attempt hit.
 */
require('dotenv').config();

const { verifyLocalFile, shutdownOcr, ID_KEYWORDS } = require('../utils/verifyId');

const [, , filePath, idType, idNumber] = process.argv;

const usage = () => {
    console.error('Usage: node src/scripts/testIdVerify.js <image> <idType> <idNumber>');
    console.error(`       idType is one of: ${Object.keys(ID_KEYWORDS).map((t) => `"${t}"`).join(', ')}`);
    process.exit(1);
};

if (!filePath || !idType || !idNumber) usage();
if (!ID_KEYWORDS[idType]) {
    console.error(`Unknown ID type: ${idType}`);
    usage();
}

(async () => {
    console.log(`\nChecking ${filePath} as a ${idType} carrying ${idNumber}\n`);

    let result;
    try {
        result = await verifyLocalFile(filePath, idType, idNumber);
    } catch (err) {
        console.error('Could not read that file:', err.message);
        await shutdownOcr();
        process.exit(1);
    }

    if (result.error) {
        console.error(result.error);
        await shutdownOcr();
        process.exit(1);
    }

    for (const attempt of result.attempts) {
        console.log(`── pass: ${attempt.pass} ───────────────────────────────`);
        console.log(`   characters read : ${attempt.chars}`);
        console.log(`   ${attempt.keywordFound ? '✓' : '✗'} recognised as a ${idType}`);
        console.log(`   ${attempt.numberFound ? '✓' : '✗'} found the number ${idNumber}`);
        if (attempt.maskedFound) console.log('   ✓ masked Aadhaar, last four matched');
        if (!attempt.keywordFound && attempt.detectedType) {
            console.log(`   → this looks like a ${attempt.detectedType} instead`);
        }
        // The whole point of the script: see what Tesseract actually got.
        console.log('   text read:');
        console.log(attempt.text.split('\n').filter((l) => l.trim()).map((l) => `     | ${l.trim()}`).join('\n') || '     | (nothing)');
        console.log('');
    }

    console.log(result.matched
        ? '✅ VERIFIED  this document would be accepted.\n'
        : '❌ NO MATCH  this document would be rejected.\n');

    await shutdownOcr();
    process.exit(result.matched ? 0 : 2);
})();
