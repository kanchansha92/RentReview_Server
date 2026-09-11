
// Digit-like characters people use to dodge naive filters.
const HOMOGLYPHS = {
    o: '0', O: '0', l: '1', I: '1', i: '1', S: '5', s: '5',
    '𝟎': '0', '𝟏': '1',
};

/**
 * Fold the text so obfuscated numbers still match: unify separators, map the
 * common letter-for-digit substitutions, and strip the spacing people insert
 * between digits ("9 8 7 6 5 4 3 2 1 0").
 */
const normalise = (input) => {
    let text = String(input || '');
    // Unicode dashes and dots people paste from phones/word processors.
    text = text.replace(/[‐-―−]/g, '-').replace(/[·•]/g, '.');
    // Letter-for-digit substitution, but only when the character sits between
    // digits  otherwise ordinary words become numbers.
    text = text.replace(/(?<=\d\s*)[oOlIiSs](?=\s*\d)/g, (c) => HOMOGLYPHS[c] || c);
    return text;
};

/** Digits only, for length checks. */
const digitsOf = (s) => s.replace(/\D/g, '');

// Pull out every maximal run of digits, tolerating the separators people
// actually type inside a number (single spaces or dashes). Each run keeps its
// grouping, because grouping is what distinguishes a formatted ID from a list
// of rent figures.
const digitRuns = (text) => {
    const runs = [];
    const re = /\d(?:[\s-]?\d)*/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const raw = m[0];
        runs.push({
            digits: digitsOf(raw),
            groups: raw.split(/[\s-]/).filter(Boolean).map((g) => g.length),
        });
    }
    return runs;
};

// A phone number. Separators are NOT capped here: typing "9 8 7 6 5 4 3 2 1 0"
// is a deliberate attempt to slip past a filter, and is exactly what we want to
// catch. Length and leading digits carry the precision instead.
const isPhone = ({ digits: d }) =>
    (d.length === 10 && /^[6-9]/.test(d)) ||       // Indian mobile
    (d.length === 11 && d.startsWith('0')) ||      // trunk prefix
    (d.length === 12 && d.startsWith('91'));       // +91

// An Aadhaar, account or card number: 12+ digits either unbroken, or grouped in
// FOURS, which is how those numbers are universally written.
//
// The grouping requirement is doing real work. Without it, "rents were 15000
// 25000 35000 45000" glues into 20 digits and gets a review rejected, and two
// adjacent dates do the same. Groups of four are not how anyone writes a list
// of prices.
const isLongNumber = ({ digits: d, groups }) => {
    if (d.length < 12) return false;
    if (groups.length === 1) return true;                 // unbroken run
    return groups.every((g) => g === 4);                  // 4-4-4 / 4-4-4-4
};

const RULES = [
    {
        id: 'email',
        // Deliberately broad: any address at all is personal data, and there is
        // no legitimate reason for one in a rental review.
        test: (text) => /[A-Za-z0-9._%+-]+\s*(?:@|\[at\]|\(at\))\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}/i.test(text),
        message: 'Please remove the email address from your review.',
    },
    {
        id: 'long-number',
        test: (text) => digitRuns(text).some(isLongNumber),
        message:
            'Please remove the long number from your review  it looks like an ID, account or card number.',
    },
    {
        id: 'phone',
        test: (text) => digitRuns(text).some(isPhone),
        message: 'Please remove the phone number from your review.',
    },
];

/**
 * @param {...string} parts any number of user-supplied strings (title, body,
 *        pros, cons  pass them all; a phone number is just as public in a
 *        "pros" bullet as in the body).
 * @returns {{id: string, message: string}|null} the first match, or null.
 */
const detectPersonalInfo = (...parts) => {
    const text = normalise(
        parts
            .flat()
            .filter((p) => typeof p === 'string')
            .join('\n')
    );
    if (!text.trim()) return null;

    for (const rule of RULES) {
        if (rule.test(text)) return { id: rule.id, message: rule.message };
    }
    return null;
};

module.exports = { detectPersonalInfo, normalise };
