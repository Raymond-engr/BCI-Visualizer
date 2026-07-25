import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {
  app,
  bearer,
  clearTestDb,
  cookiesFrom,
  seedUser,
  startTestDb,
  stopTestDb,
} from './helpers/api';
import User from '../src/model/user.model';
import tokenService from '../src/services/token.service';

/**
 * register, login and refresh-token share one rateLimiter(20 per hour) keyed by
 * req.ip, and the app trusts a single proxy hop. Handing every request its own
 * forwarded address stops a limit meant for one abusive client from capping how
 * many cases this file may contain; the limiter itself is covered below.
 */
let clientCount = 0;
const fromNewClient = (test: request.Test): request.Test => {
  clientCount += 1;
  return test.set(
    'X-Forwarded-For',
    `10.0.${Math.floor(clientCount / 254)}.${(clientCount % 254) + 1}`
  );
};

const registerBody = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'password123',
  institution: 'Analytical Engines',
};

const blacklist = () =>
  mongoose.connection.collection('BlacklistedTokens');

beforeAll(startTestDb);
afterEach(clearTestDb);
afterAll(stopTestDb);

describe('POST /api/v1/auth/register', () => {
  it('creates an account and returns an access token with the user', async () => {
    const res = await fromNewClient(
      request(app).post('/api/v1/auth/register').send(registerBody)
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      message: 'Account created successfully',
    });
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.user).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'researcher',
      institution: 'Analytical Engines',
    });
  });

  it('never returns the password', async () => {
    const res = await fromNewClient(
      request(app).post('/api/v1/auth/register').send(registerBody)
    );

    expect(res.body.data.user).not.toHaveProperty('password');
  });

  it('stores the password hashed', async () => {
    await fromNewClient(
      request(app).post('/api/v1/auth/register').send(registerBody)
    );

    const stored = await User.findOne({ email: 'ada@example.com' }).select(
      '+password'
    );
    expect(stored!.password).not.toBe('password123');
    expect(await stored!.comparePassword('password123')).toBe(true);
  });

  it('sets an httpOnly refresh token cookie and stores it on the user', async () => {
    const res = await fromNewClient(
      request(app).post('/api/v1/auth/register').send(registerBody)
    );

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith('refreshToken=')
    );
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);

    const stored = await User.findOne({ email: 'ada@example.com' }).select(
      '+refreshToken'
    );
    expect(cookie).toContain(encodeURIComponent(stored!.refreshToken!));
  });

  it('rejects an email that is already registered', async () => {
    await seedUser({ email: 'ada@example.com' });

    const res = await fromNewClient(
      request(app).post('/api/v1/auth/register').send(registerBody)
    );

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A record with this email already exists');
    expect(await User.countDocuments({ email: 'ada@example.com' })).toBe(1);
  });

  it('rejects a password shorter than 8 characters', async () => {
    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/register')
        .send({ ...registerBody, password: 'short' })
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Password must be at least 8 characters');
    expect(await User.countDocuments()).toBe(0);
  });

  it('rejects an invalid email address', async () => {
    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/register')
        .send({ ...registerBody, email: 'not-an-email' })
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid email address');
  });

  it('rejects a name shorter than 2 characters', async () => {
    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/register')
        .send({ ...registerBody, name: 'A' })
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Name must be at least 2 characters');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns an access token for correct credentials', async () => {
    await seedUser({ email: 'ada@example.com', password: 'password123' });

    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'password123' })
    );

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged in successfully');
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(res.body.data.user.email).toBe('ada@example.com');
    expect(cookiesFrom(res)).toContain('refreshToken=');
  });

  it('records the login timestamp', async () => {
    const { user } = await seedUser({ email: 'ada@example.com' });
    expect(user.lastLogin).toBeUndefined();

    await fromNewClient(
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'password123' })
    );

    const stored = await User.findById(user._id);
    expect(stored!.lastLogin).toBeInstanceOf(Date);
  });

  it('rejects an incorrect password', async () => {
    await seedUser({ email: 'ada@example.com' });

    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'wrong-password' })
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Incorrect password');
  });

  it('rejects an email with no account', async () => {
    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'nobody@example.com', password: 'password123' })
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No account found with this email address');
  });

  it('rejects a deactivated account', async () => {
    await seedUser({ email: 'ada@example.com', isActive: false });

    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com', password: 'password123' })
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe(
      'Your account is not active. Please contact administrator.'
    );
  });

  it('rejects a request with no password', async () => {
    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'ada@example.com' })
    );

    expect(res.status).toBe(400);
  });

  it('caps repeated attempts from one client', async () => {
    const attempt = () =>
      request(app)
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', '198.51.100.7')
        .send({ email: 'nobody@example.com', password: 'password123' });

    for (let i = 0; i < 20; i++) {
      const res = await attempt();
      expect(res.body.message).toBe('No account found with this email address');
    }

    const capped = await attempt();
    expect(capped.status).toBe(401);
    expect(capped.body.message).toBe('Rate limit exceeded');
  });
});

describe('POST /api/v1/auth/refresh-token', () => {
  /**
   * generateTokens derives `iat` from the current second, so a token minted and
   * rotated inside the same second is byte-identical and the rotation would not
   * be observable. Signing the stored token a minute back reproduces the normal
   * case, where a client refreshes long after it logged in.
   */
  const seedRefreshableUser = async () => {
    const { user } = await seedUser({ email: 'ada@example.com' });
    const issuedAt = Math.floor(Date.now() / 1000) - 60;
    const refreshToken = jwt.sign(
      {
        userId: String(user._id),
        email: user.email,
        role: user.role,
        iat: issuedAt,
        exp: issuedAt + 7 * 24 * 60 * 60,
      },
      process.env.JWT_REFRESH_SECRET as string
    );

    user.refreshToken = refreshToken;
    await user.save();

    return { user, refreshToken };
  };

  it('rotates the refresh token and returns a new access token', async () => {
    const { refreshToken } = await seedRefreshableUser();

    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refreshToken=${refreshToken}`)
    );

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Token refreshed');
    expect(typeof res.body.data.accessToken).toBe('string');

    const rotated = cookiesFrom(res);
    expect(rotated).toContain('refreshToken=');
    expect(rotated).not.toContain(encodeURIComponent(refreshToken));
  });

  it('persists the rotated token against the user', async () => {
    const { user, refreshToken } = await seedRefreshableUser();

    await fromNewClient(
      request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refreshToken=${refreshToken}`)
    );

    const stored = await User.findById(user._id).select('+refreshToken');
    expect(stored!.refreshToken).not.toBe(refreshToken);
  });

  it('blacklists the surrendered token so it cannot be replayed', async () => {
    const { refreshToken } = await seedRefreshableUser();

    await fromNewClient(
      request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refreshToken=${refreshToken}`)
    );

    expect(await blacklist().countDocuments({ token: refreshToken })).toBe(1);

    const replay = await fromNewClient(
      request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refreshToken=${refreshToken}`)
    );

    expect(replay.status).toBe(401);
    expect(replay.body.message).toBe('Invalid refresh token');
  });

  it('rejects a request with no cookie', async () => {
    const res = await fromNewClient(
      request(app).post('/api/v1/auth/refresh-token')
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Refresh token required');
  });

  it('rejects a token that is no longer the one stored on the user', async () => {
    const { user, refreshToken } = await seedRefreshableUser();

    user.refreshToken = 'a-token-issued-to-some-newer-device';
    await user.save();

    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refreshToken=${refreshToken}`)
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Refresh token has been revoked');
  });

  it('rejects a malformed token', async () => {
    const res = await fromNewClient(
      request(app)
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', 'refreshToken=not-a-jwt')
    );

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid refresh token');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears the cookie and drops the stored refresh token', async () => {
    const { user } = await seedUser({ email: 'ada@example.com' });
    const { refreshToken } = tokenService.generateTokens({
      userId: String(user._id),
      email: user.email,
      role: user.role,
    });
    user.refreshToken = refreshToken;
    await user.save();

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `refreshToken=${refreshToken}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out successfully');
    // Read the raw Set-Cookie rather than cookiesFrom(), which collapses each
    // cookie to its name=value pair and would hide both the emptied value and
    // the expiry that actually retires the cookie in the browser.
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cleared = setCookie.find((cookie) => cookie.startsWith('refreshToken='));
    expect(cleared).toMatch(/^refreshToken=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);

    const stored = await User.findById(user._id).select('+refreshToken');
    expect(stored!.refreshToken).toBeUndefined();
  });

  it('succeeds when there is no session to end', async () => {
    const res = await request(app).post('/api/v1/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/v1/auth/verify-token', () => {
  it('returns the authenticated user for a valid token', async () => {
    const { user, accessToken } = await seedUser({ email: 'ada@example.com' });

    const res = await request(app)
      .get('/api/v1/auth/verify-token')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Token is valid');
    expect(res.body.data.user).toMatchObject({
      _id: String(user._id),
      email: 'ada@example.com',
      role: 'researcher',
    });
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get('/api/v1/auth/verify-token');

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Access token required');
  });

  it('rejects a malformed token', async () => {
    const res = await request(app)
      .get('/api/v1/auth/verify-token')
      .set('Authorization', bearer('not-a-jwt'));

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid access token');
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { user } = await seedUser({ email: 'ada@example.com' });
    const forged = jwt.sign({ userId: String(user._id) }, 'the-wrong-secret');

    const res = await request(app)
      .get('/api/v1/auth/verify-token')
      .set('Authorization', bearer(forged));

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid access token');
  });

  it('rejects a token for a user that no longer exists', async () => {
    const { user, accessToken } = await seedUser({ email: 'ada@example.com' });
    await User.findByIdAndDelete(user._id);

    const res = await request(app)
      .get('/api/v1/auth/verify-token')
      .set('Authorization', bearer(accessToken));

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('User not found');
  });
});
