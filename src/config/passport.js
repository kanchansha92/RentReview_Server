const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const User = require('../models/User');

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`,
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    let user = await User.findOne({ googleId: profile.id });

                    if (!user) {
                        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
                        if (!email) {
                            return done(null, false, { message: 'no-email' });
                        }

                        const existing = await User.findOne({ email: email.toLowerCase() });

                        if (existing) {
                            // Only auto-link to an account whose email ownership has
                            // actually been proven. Otherwise anyone can pre-register
                            // a victim's address and inherit their Google identity.
                            if (existing.isVerified !== true) {
                                return done(null, false, { message: 'account-exists' });
                            }
                            existing.googleId = profile.id;
                            await existing.save();
                            user = existing;
                        } else {
                            user = await User.create({
                                name: profile.displayName,
                                email: email,
                                googleId: profile.id,
                                isVerified: true,
                            });
                        }
                    }

                    return done(null, user);
                } catch (error) {
                    return done(error, null);
                }
            }
        )
    );
} else {
    console.warn('Google OAuth credentials missing. Google login will not work.');
}

if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    passport.use(
        new FacebookStrategy(
            {
                clientID: process.env.FACEBOOK_APP_ID,
                clientSecret: process.env.FACEBOOK_APP_SECRET,
                callbackURL: `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/facebook/callback`,
                profileFields: ['id', 'displayName', 'emails'],
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    let user = await User.findOne({ facebookId: profile.id });

                    if (!user) {
                        // Facebook may not release an email at all. Never use the
                        // synthetic `<id>@facebook.com` address to *match* an
                        // existing account — it is only a placeholder for a
                        // brand-new record.
                        const realEmail = profile.emails && profile.emails[0] ? profile.emails[0].value : null;

                        const existing = realEmail
                            ? await User.findOne({ email: realEmail.toLowerCase() })
                            : null;

                        if (existing) {
                            // Only auto-link to an already email-verified account.
                            if (existing.isVerified !== true) {
                                return done(null, false, { message: 'account-exists' });
                            }
                            existing.facebookId = profile.id;
                            await existing.save();
                            user = existing;
                        } else {
                            user = await User.create({
                                name: profile.displayName,
                                email: realEmail || `${profile.id}@facebook.com`,
                                facebookId: profile.id,
                                isVerified: true,
                            });
                        }
                    }

                    return done(null, user);
                } catch (error) {
                    return done(error, null);
                }
            }
        )
    );
} else {
    console.warn('Facebook OAuth credentials missing. Facebook login will not work.');
}

passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (error) {
        done(error, null);
    }
});

module.exports = passport;
