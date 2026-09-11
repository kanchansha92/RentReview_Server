
require('dotenv').config();

const mongoose = require('mongoose');
const User = require('../models/User');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const REVOKE = args.includes('--revoke');
const email = args.find((a) => !a.startsWith('--'));

const main = async () => {
    if (!process.env.MONGO_URI) {
        console.error('MONGO_URI is not set. Run this from the backend directory with your .env in place.');
        process.exit(1);
    }
    if (!LIST && !email) {
        console.error('Usage: node src/scripts/promoteAdmin.js <email> [--revoke]\n       node src/scripts/promoteAdmin.js --list');
        process.exit(1);
    }

    await mongoose.connect(process.env.MONGO_URI);

    if (LIST) {
        const admins = await User.find({ role: 'admin' }).select('name email createdAt').sort({ createdAt: 1 });
        if (admins.length === 0) {
            console.log('No admins. The ID-verification queue is currently unreachable by anyone.');
        } else {
            console.log(`${admins.length} admin(s):`);
            admins.forEach((a) => console.log(`  ${a.email}  (${a.name})`));
        }
        await mongoose.disconnect();
        return;
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
        console.error(`No account found for ${email}. Sign up first, then run this.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    const target = REVOKE ? 'tenant' : 'admin';
    if (user.role === target) {
        console.log(`${user.email} is already '${target}'. Nothing to do.`);
        await mongoose.disconnect();
        return;
    }

    const previous = user.role;
    user.role = target;
    // validateModifiedOnly: accounts created before the current field rules must
    // not be blocked by a field this change never touched.
    await user.save({ validateModifiedOnly: true });

    console.log(`${user.email}: ${previous} → ${target}`);
    if (target === 'admin') {
        console.log('\nNOTE: existing JWTs carry no role  the role is read from the database on every');
        console.log('request  so this takes effect immediately, with no need to sign out and back in.');
    }

    await mongoose.disconnect();
};

main().catch(async (err) => {
    console.error('Failed:', err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
