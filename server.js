require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const MongoStore = require('connect-mongo');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const session = require('express-session');
const helmet = require('helmet');
const mongoose = require('mongoose');

const app = express();
const port = Number(process.env.PORT) || 3000;
const mongoUri = process.env.MONGODB_URI;
const sessionSecret = process.env.SESSION_SECRET;
const setupToken = process.env.OWNER_SETUP_TOKEN;
const STATUS_VALUES = ['present', 'half', 'paid', 'unpaid', ''];
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'CAD', 'AUD'];

if (!mongoUri || !sessionSecret || sessionSecret.length < 32) {
  console.error('Set MONGODB_URI and a SESSION_SECRET of at least 32 characters in .env.');
  process.exit(1);
}

const shopSchema = new mongoose.Schema({
  ownerName: { type: String, required: true, trim: true, maxlength: 80 },
  currency: { type: String, enum: CURRENCIES, default: 'INR' },
}, { timestamps: true });

const userSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  role: { type: String, enum: ['owner', 'worker'], required: true },
  displayName: { type: String, required: true, trim: true, maxlength: 80 },
  username: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 40 },
  passwordHash: { type: String, required: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
}, { timestamps: true });
userSchema.index({ role: 1 }, { unique: true, partialFilterExpression: { role: 'owner' } });

const employeeSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  payType: { type: String, enum: ['daily', 'monthly'], required: true },
  rate: { type: Number, min: 0, required: true },
  monthlyLeaveAllowance: { type: Number, min: 0, max: 31, required: true },
  leaveOverrides: { type: Map, of: Number, default: {} },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const attendanceSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  status: { type: String, enum: ['present', 'half', 'paid', 'unpaid'], required: true },
  deductionAmount: { type: Number, min: 0, default: 0 },
  recordedBy: { type: String, required: true, maxlength: 80 },
  updatedBy: { type: String, required: true, maxlength: 80 },
}, { timestamps: true });
attendanceSchema.index({ employeeId: 1, date: 1 }, { unique: true });

const auditSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  employeeName: { type: String, required: true, maxlength: 80 },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  previousStatus: { type: String, enum: STATUS_VALUES, required: false },
  status: { type: String, enum: STATUS_VALUES, required: false },
  previousDeductionAmount: { type: Number, min: 0, default: 0 },
  deductionAmount: { type: Number, min: 0, default: 0 },
  actor: { type: String, required: true, maxlength: 80 },
  actorRole: { type: String, enum: ['owner', 'worker'], required: true },
}, { timestamps: true });
auditSchema.index({ shopId:  1, createdAt: -1 });

const Shop = mongoose.model('Shop', shopSchema);
const User = mongoose.model('User', userSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Audit = mongoose.model('Audit', auditSchema);

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use(express.json({ limit: '20kb' }));
app.use(session({
  name: 'daymark.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoUri, collectionName: 'sessions', ttl: 60 * 60 * 24 * 7 }),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait and try again.' },
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validUsername(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{3,40}$/.test(value.trim());
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128;
}

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 80;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function csrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

function requireOwner(req, res, next) {
  if (req.session.role !== 'owner') return res.status(403).json({ error: 'Owner access required.' });
  next();
}

function requireCsrf(req, res, next) {
  const expected = req.session.csrfToken;
  const received = req.get('X-CSRF-Token');
  if (!expected || !received || !/^[a-f0-9]{64}$/.test(received) ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
    return res.status(403).json({ error: 'Session security check failed. Reload the page and try again.' });
  }
  next();
}

function ownerSetupTokenMatches(received) {
  if (!setupToken || typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(setupToken);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function makeCsrfToken(req, res) {
  const token = csrfToken(req);
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  return token;
}

function workerJson(employee, month) {
  const override = typeof employee.leaveOverrides?.get === 'function'
    ? employee.leaveOverrides.get(month)
    : employee.leaveOverrides?.[month];
  return {
    id: employee._id.toString(),
    name: employee.name,
    username: employee.user?.username ?? employee.userId?.username,
    payType: employee.payType,
    rate: employee.rate,
    monthlyLeaveAllowance: employee.monthlyLeaveAllowance,
    allowanceThisMonth: override ?? employee.monthlyLeaveAllowance,
  };
}

async function getShop(req) {
  return Shop.findById(req.session.shopId).lean();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));
app.get('/owner-setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner-setup.html')));
app.get('/owner-setup.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'owner-setup.js')));

app.get('/api/setup-status', asyncRoute(async (req, res) => {
  const ownerExists = await User.exists({ role: 'owner' });
  res.json({ ownerExists: Boolean(ownerExists), setupConfigured: Boolean(setupToken) });
}));

app.get('/api/me', asyncRoute(async (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  const user = await User.findById(req.session.userId).lean();
  if (!user) {
    req.session.destroy(() => {});
    return res.json({ authenticated: false });
  }
  const token = await makeCsrfToken(req, res);
  const payload = {
    authenticated: true,
    csrfToken: token,
    role: user.role,
    name: user.displayName,
  };
  if (user.role === 'owner') {
    const shop = await getShop(req);
    payload.currency = shop?.currency ?? 'INR';
  } else {
    const employee = await Employee.findOne({ _id: user.employeeId, shopId: user.shopId, active: true }).lean();
    if (!employee) return res.status(403).json({ error: 'This worker account is not active.' });
    payload.employee = {
      id: employee._id.toString(),
      name: employee.name,
      payType: employee.payType,
      rate: employee.rate,
      monthlyLeaveAllowance: employee.monthlyLeaveAllowance,
    };
  }
  res.json(payload);
}));

app.post('/api/setup-owner', authLimiter, asyncRoute(async (req, res) => {
  if (!setupToken) return res.status(503).json({ error: 'Owner setup is not configured on the server.' });
  if (!ownerSetupTokenMatches(req.body.setupToken)) return res.status(403).json({ error: 'Invalid setup token.' });
  if (await User.exists({ role: 'owner' })) return res.status(409).json({ error: 'Owner setup has already been completed.' });
  const { name, username, password } = req.body;
  if (!validName(name) || !validUsername(username) || !validPassword(password)) {
    return res.status(400).json({ error: 'Enter a name, a username (3–40 letters/numbers/._-), and a password of at least 8 characters.' });
  }
  const shop = await Shop.create({ ownerName: name.trim() });
  try {
    const user = await User.create({
      shopId: shop._id,
      role: 'owner',
      displayName: name.trim(),
      username: username.trim().toLowerCase(),
      passwordHash: await bcrypt.hash(password, 12),
    });
    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'Could not start the owner session.' });
      req.session.userId = user._id.toString();
      req.session.shopId = shop._id.toString();
      req.session.role = 'owner';
      csrfToken(req);
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ error: 'Could not save the owner session.' });
        res.status(201).json({ ok: true });
      });
    });
  } catch (error) {
    await Shop.deleteOne({ _id: shop._id });
    if (error.code === 11000) return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
}));

app.post('/api/login', authLimiter, asyncRoute(async (req, res) => {
  const { username, password } = req.body;
  if (!validUsername(username) || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter your username and password.' });
  }
  const user = await User.findOne({ username: username.trim().toLowerCase() });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Username or password is incorrect.' });
  }
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Could not start your session.' });
    req.session.userId = user._id.toString();
    req.session.shopId = user.shopId.toString();
    req.session.role = user.role;
    csrfToken(req);
    req.session.save((saveError) => {
      if (saveError) return res.status(500).json({ error: 'Could not save your session.' });
      res.json({ ok: true });
    });
  });
}));

app.post('/api/logout', requireAuth, requireCsrf, (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Could not sign out.' });
    res.clearCookie('daymark.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
    res.json({ ok: true });
  });
});

app.get('/api/shop', requireAuth, asyncRoute(async (req, res) => {
  const shop = await getShop(req);
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  if (req.session.role === 'worker') {
    const employee = await Employee.findOne({ userId: req.session.userId, shopId: req.session.shopId, active: true }).populate('userId', 'username');
    if (!employee) return res.status(404).json({ error: 'Worker profile not found.' });
    const month = validMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
    return res.json({ currency: shop.currency, employees: [workerJson(employee, month)] });
  }
  const month = validMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const employees = await Employee.find({ shopId: req.session.shopId, active: true }).populate('userId', 'username').sort({ name: 1 });
  res.json({ currency: shop.currency, employees: employees.map((employee) => workerJson(employee, month)) });
}));

app.post('/api/workers', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { name, username, password, payType, rate, monthlyLeaveAllowance, month, allowanceThisMonth } = req.body;
  if (!validName(name) || !validUsername(username) || !validPassword(password) ||
      !['daily', 'monthly'].includes(payType) || !Number.isFinite(rate) || rate < 0 ||
      !Number.isInteger(monthlyLeaveAllowance) || monthlyLeaveAllowance < 0 || monthlyLeaveAllowance > 31 ||
      !validMonth(month) || !Number.isInteger(allowanceThisMonth) || allowanceThisMonth < 0 || allowanceThisMonth > 31) {
    return res.status(400).json({ error: 'Check the worker details, login credentials, pay rate, and monthly leave allowance.' });
  }
  const employee = new Employee({
    shopId: req.session.shopId,
    name: name.trim(),
    payType,
    rate,
    monthlyLeaveAllowance,
    leaveOverrides: { [month]: allowanceThisMonth },
    userId: new mongoose.Types.ObjectId(),
  });
  try {
    const user = await User.create({
      _id: employee.userId,
      shopId: req.session.shopId,
      role: 'worker',
      displayName: employee.name,
      username: username.trim().toLowerCase(),
      passwordHash: await bcrypt.hash(password, 12),
      employeeId: employee._id,
    });
    await employee.save();
    res.status(201).json(workerJson({ ...employee.toObject(), user: { username: user.username } }, month));
  } catch (error) {
    await User.deleteOne({ _id: employee.userId });
    await Employee.deleteOne({ _id: employee._id });
    if (error.code === 11000) return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
}));

app.patch('/api/workers/:id', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { name, username, password, payType, rate, monthlyLeaveAllowance, month, allowanceThisMonth } = req.body;
  if (!validName(name) || !validUsername(username) ||
      (password !== '' && password !== undefined && !validPassword(password)) ||
      !['daily', 'monthly'].includes(payType) || !Number.isFinite(rate) || rate < 0 ||
      !Number.isInteger(monthlyLeaveAllowance) || monthlyLeaveAllowance < 0 || monthlyLeaveAllowance > 31 ||
      !validMonth(month) || !Number.isInteger(allowanceThisMonth) || allowanceThisMonth < 0 || allowanceThisMonth > 31) {
    return res.status(400).json({ error: 'Check the worker details, login credentials, pay rate, and monthly leave allowance.' });
  }
  const employee = await Employee.findOne({ _id: req.params.id, shopId: req.session.shopId, active: true });
  if (!employee) return res.status(404).json({ error: 'Worker not found.' });
  const user = await User.findOne({ _id: employee.userId, shopId: req.session.shopId });
  if (!user) return res.status(404).json({ error: 'Worker account not found.' });
  employee.name = name.trim();
  employee.payType = payType;
  employee.rate = rate;
  employee.monthlyLeaveAllowance = monthlyLeaveAllowance;
  employee.leaveOverrides.set(month, allowanceThisMonth);
  user.displayName = employee.name;
  user.username = username.trim().toLowerCase();
  if (password) user.passwordHash = await bcrypt.hash(password, 12);
  try {
    await Promise.all([employee.save(), user.save()]);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
  res.json(workerJson({ ...employee.toObject(), user: { username: user.username } }, month));
}));

app.patch('/api/settings', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  if (!CURRENCIES.includes(req.body.currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
  const shop = await Shop.findByIdAndUpdate(req.session.shopId, { currency: req.body.currency }, { new: true });
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  res.json({ currency: shop.currency });
}));

app.get('/api/attendance', requireAuth, asyncRoute(async (req, res) => {
  if (!validMonth(req.query.month)) return res.status(400).json({ error: 'Choose a valid month.' });
  let employeeId = req.query.employeeId;
  if (req.session.role === 'worker') {
    const employee = await Employee.findOne({ userId: req.session.userId, shopId: req.session.shopId, active: true }).select('_id');
    if (!employee) return res.status(404).json({ error: 'Worker profile not found.' });
    employeeId = employee._id.toString();
  }
  if (!mongoose.isValidObjectId(employeeId)) return res.status(400).json({ error: 'Choose a valid worker.' });
  const employee = await Employee.findOne({ _id: employeeId, shopId: req.session.shopId, active: true })
    .select('payType rate monthlyLeaveAllowance leaveOverrides');
  if (!employee) return res.status(404).json({ error: 'Worker not found.' });
  const allowance = employee.leaveOverrides.get(req.query.month) ?? employee.monthlyLeaveAllowance;
  const daysInMonth = new Date(Date.UTC(
    Number(req.query.month.slice(0, 4)),
    Number(req.query.month.slice(5, 7)),
    0,
  )).getUTCDate();
  const records = await Attendance.find({
    employeeId,
    shopId: req.session.shopId,
    date: { $gte: `${req.query.month}-01`, $lte: `${req.query.month}-31` },
  }).sort({ date: 1 }).lean();
  res.json({ entries: records.map((record) => ({
    date: record.date,
    status: record.status,
    recordedBy: record.recordedBy,
    deductionAmount: record.deductionAmount ?? (
      employee.payType === 'monthly' && record.status === 'unpaid'
        ? Number((employee.rate / Math.max(1, daysInMonth - allowance)).toFixed(2))
        : 0
    ),
  })) });
}));

async function applyAttendanceChanges({ req, dates, status, employeeId, deductionAmount, res }) {
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 31 ||
      dates.some((date) => !validDate(date)) ||
      !STATUS_VALUES.includes(status) ||
      !mongoose.isValidObjectId(employeeId) ||
      (deductionAmount !== undefined && (!Number.isFinite(deductionAmount) || deductionAmount < 0 || deductionAmount > 100000000))) {
    res.status(400).json({ error: 'Choose valid dates, a worker, an attendance status, and a valid deduction amount.' });
    return;
  }
  const uniqueDates = [...new Set(dates)].sort();
  if (uniqueDates.length !== dates.length || uniqueDates.some((date) => date.slice(0, 7) !== uniqueDates[0].slice(0, 7))) {
    res.status(400).json({ error: 'Select unique dates from one calendar month.' });
    return;
  }
  let targetEmployeeId = employeeId;
  if (req.session.role === 'worker') {
    const employee = await Employee.findOne({ userId: req.session.userId, shopId: req.session.shopId, active: true }).select('_id');
    if (!employee || employee._id.toString() !== employeeId) {
      res.status(403).json({ error: 'Workers can only edit their own attendance.' });
      return;
    }
    targetEmployeeId = employee._id;
  }
  const employee = await Employee.findOne({ _id: targetEmployeeId, shopId: req.session.shopId, active: true });
  if (!employee) {
    res.status(404).json({ error: 'Worker not found.' });
    return;
  }
  if (req.session.role !== 'owner' && deductionAmount !== undefined) {
    res.status(403).json({ error: 'Only the owner can set wage deductions.' });
    return;
  }
  const actor = await User.findById(req.session.userId).select('displayName role').lean();
  if (!actor) {
    res.status(401).json({ error: 'Please sign in again.' });
    return;
  }
  let leaveLimitError = '';
  let changedCount = 0;
  const transaction = await mongoose.startSession();
  try {
    await transaction.withTransaction(async () => {
      changedCount = 0;
      leaveLimitError = '';
      const existingRecords = await Attendance.find({
        employeeId: targetEmployeeId,
        shopId: req.session.shopId,
        date: { $in: uniqueDates },
      }).session(transaction).lean();
      const existingByDate = new Map(existingRecords.map((record) => [record.date, record]));
      const month = uniqueDates[0].slice(0, 7);
      if (status === 'paid') {
        const override = employee.leaveOverrides.get(month);
        const allowance = override ?? employee.monthlyLeaveAllowance;
        const currentPaidCount = await Attendance.countDocuments({
          employeeId: targetEmployeeId,
          shopId: req.session.shopId,
          date: { $gte: `${month}-01`, $lte: `${month}-31` },
          status: 'paid',
        }).session(transaction);
        const selectedPreviouslyPaid = uniqueDates.filter((date) => existingByDate.get(date)?.status === 'paid').length;
        const newPaidCount = uniqueDates.filter((date) => existingByDate.get(date)?.status !== 'paid').length;
        if (currentPaidCount - selectedPreviouslyPaid + newPaidCount > allowance) {
          leaveLimitError = `This update would exceed the ${allowance} paid leave days allowed for ${month}.`;
          return;
        }
      }
      for (const date of uniqueDates) {
        const previous = existingByDate.get(date);
        const previousStatus = previous?.status ?? '';
        const previousDeductionAmount = previous?.deductionAmount ?? 0;
        const daysInMonth = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
        const allowance = employee.leaveOverrides.get(month) ?? employee.monthlyLeaveAllowance;
        const defaultDeduction = employee.payType === 'monthly'
          ? Number((employee.rate / Math.max(1, daysInMonth - allowance)).toFixed(2))
          : 0;
        const appliedDeduction = status === 'unpaid' && employee.payType === 'monthly'
          ? deductionAmount ?? defaultDeduction
          : 0;
        if (previousStatus === status && previousDeductionAmount === appliedDeduction) continue;
        if (status) {
          await Attendance.findOneAndUpdate(
            { employeeId: targetEmployeeId, date, shopId: req.session.shopId },
            {
              $set: { status, deductionAmount: appliedDeduction, updatedBy: actor.displayName },
              $setOnInsert: { shopId: req.session.shopId, employeeId: targetEmployeeId, date, recordedBy: actor.displayName },
            },
            { upsert: true, new: true, runValidators: true, session: transaction },
          );
        } else {
          await Attendance.deleteOne({ employeeId: targetEmployeeId, date, shopId: req.session.shopId }).session(transaction);
        }
        await Audit.create([{
          shopId: req.session.shopId,
          employeeId: targetEmployeeId,
          employeeName: employee.name,
          date,
          previousStatus,
          status,
          previousDeductionAmount,
          deductionAmount: appliedDeduction,
          actor: actor.displayName,
          actorRole: actor.role,
        }], { session: transaction });
        changedCount += 1;
      }
    });
  } finally {
    await transaction.endSession();
  }
  if (leaveLimitError) {
    res.status(409).json({ error: leaveLimitError });
    return;
  }
  res.json({ ok: true, changedCount });
}

app.put('/api/attendance', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
  await applyAttendanceChanges({
    req,
    res,
    dates: [req.body.date],
    status: req.body.status,
    employeeId: req.body.employeeId,
    deductionAmount: req.body.deductionAmount,
  });
}));

app.put('/api/attendance/bulk', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  await applyAttendanceChanges({
    req,
    res,
    dates: req.body.dates,
    status: req.body.status,
    employeeId: req.body.employeeId,
    deductionAmount: req.body.deductionAmount,
  });
}));

app.get('/api/history', requireAuth, asyncRoute(async (req, res) => {
  const filter = { shopId: req.session.shopId };
  if (req.session.role === 'worker') {
    const employee = await Employee.findOne({ userId: req.session.userId, shopId: req.session.shopId, active: true }).select('_id');
    if (!employee) return res.status(404).json({ error: 'Worker profile not found.' });
    filter.employeeId = employee._id;
  } else if (req.query.employeeId) {
    if (!mongoose.isValidObjectId(req.query.employeeId)) return res.status(400).json({ error: 'Choose a valid worker.' });
    filter.employeeId = req.query.employeeId;
  }
  if (req.query.month) {
    if (!validMonth(req.query.month)) return res.status(400).json({ error: 'Choose a valid month.' });
    filter.date = { $gte: `${req.query.month}-01`, $lte: `${req.query.month}-31` };
  }
  const events = await Audit.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  res.json({ history: events.map((event) => ({
    employeeId: event.employeeId.toString(),
    employeeName: event.employeeName,
    date: event.date,
    previousStatus: event.previousStatus,
    status: event.status,
    previousDeductionAmount: event.previousDeductionAmount ?? 0,
    deductionAmount: event.deductionAmount ?? 0,
    actor: event.actor,
    role: event.actorRole,
    timestamp: event.createdAt.toISOString(),
  })) });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((error, req, res, next) => {
  console.error('Request failed:', error);
  if (res.headersSent) return next(error);
  if (error.name === 'ValidationError' || error.name === 'CastError') {
    return res.status(400).json({ error: 'The submitted information is invalid.' });
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

mongoose.connect(mongoUri)
  .then(() => app.listen(port, () => console.log(`Daymark is ready at http://localhost:${port}`)))
  .catch((error) => {
    console.error('Could not connect to MongoDB:', error.message);
    process.exit(1);
  });
