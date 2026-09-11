
const MIN_LENGTH = 8;
// bcrypt only hashes the first 72 bytes; anything longer is silently truncated,
// which is confusing rather than dangerous  cap it so the user knows.
const MAX_LENGTH = 72;

// Top entries from the usual breach-derived lists, lowercased. Kept short on
// purpose  this blocks the passwords that get guessed in the first second,
// not every weak one.
const COMMON_PASSWORDS = new Set([
    '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
    'passw0rd', 'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1',
    'letmein1', 'sunshine', 'princess', 'football', 'baseball', 'superman',
    'trustno1', 'abcd1234', 'abc12345', '11111111', '00000000', '87654321',
    'india123', 'india@123', 'rentreview', 'rentreview1', 'rentreview123',
    'monkey123', 'dragon123', 'shadow123', 'master123', 'michael1', 'jennifer',
    'computer', 'internet', 'whatever', 'changeme', 'starwars', 'pokemon1',
]);

/**
 * @param {unknown} password
 * @param {{ email?: string, name?: string }} [context]  identifiers the
 *        password must not simply be a copy of.
 * @returns {string|null} a user-facing reason the password is rejected, or null.
 */
const validatePassword = (password, context = {}) => {
    if (typeof password !== 'string' || !password) {
        return 'Password is required.';
    }
    if (password.length < MIN_LENGTH) {
        return `Password must be at least ${MIN_LENGTH} characters.`;
    }
    if (password.length > MAX_LENGTH) {
        return `Password must be ${MAX_LENGTH} characters or fewer.`;
    }

    const lowered = password.toLowerCase();
    if (COMMON_PASSWORDS.has(lowered)) {
        return 'That password is too common. Please choose something less guessable.';
    }
    // "aaaaaaaa", "11111111"
    if (/^(.)\1+$/.test(password)) {
        return 'Password cannot be a single repeated character.';
    }

    const email = typeof context.email === 'string' ? context.email.trim().toLowerCase() : '';
    if (email) {
        const localPart = email.split('@')[0];
        if (lowered === email || (localPart.length >= 4 && lowered === localPart)) {
            return 'Password cannot be the same as your email address.';
        }
    }
    const name = typeof context.name === 'string' ? context.name.trim().toLowerCase() : '';
    if (name && name.length >= 4 && lowered === name) {
        return 'Password cannot be the same as your name.';
    }

    return null;
};

module.exports = { validatePassword, MIN_LENGTH, MAX_LENGTH };
