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
  name: { type: String, required: true, trim: true, maxlength: 80 },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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

const employeeSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  payType: { type: String, enum: ['daily', 'monthly'], required: true },
  rate: { type: Number, min: 0, required: true },
  monthlyLeaveAllowance: { type: Number, min: 0, max: 31, required: true },
  leaveOverrides: { type: Map, of: Number, default: {} },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });
employeeSchema.index({ shopId: 1, userId: 1 }, { unique: true });

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

const payrollPeriodSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  finalizedAt: { type: Date, default: null },
  finalizedBy: { type: String, default: '' },
  lastChangeAt: { type: Date, default: null },
  lastChangeBy: { type: String, default: '' },
  snapshot: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });
payrollPeriodSchema.index({ shopId: 1, month: 1 }, { unique: true });

const adjustmentSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  type: { type: String, enum: ['advance', 'bonus', 'deduction'], required: true },
  amount: { type: Number, min: 0.01, required: true },
  note: { type: String, trim: true, maxlength: 200, default: '' },
  actor: { type: String, required: true, maxlength: 80 },
  voidedAt: { type: Date, default: null },
  voidedBy: { type: String, default: '' },
}, { timestamps: true });
adjustmentSchema.index({ shopId: 1, month: 1, createdAt: -1 });

const closureSchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  seriesId: { type: String, default: '' },
  label: { type: String, required: true, trim: true, maxlength: 80 },
  type: { type: String, enum: ['holiday', 'weekly_off'], required: true },
  payTreatment: { type: String, enum: ['paid', 'unpaid'], required: true },
  actor: { type: String, required: true, maxlength: 80 },
  active: { type: Boolean, default: true },
  voidedAt: { type: Date, default: null },
  voidedBy: { type: String, default: '' },
}, { timestamps: true });
closureSchema.index({ shopId: 1, date: 1 }, { unique: true, partialFilterExpression: { active: true } });

const activitySchema = new mongoose.Schema({
  shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  action: { type: String, required: true, maxlength: 40 },
  description: { type: String, required: true, maxlength: 500 },
  actor: { type: String, required: true, maxlength: 80 },
}, { timestamps: true });
activitySchema.index({ shopId: 1, month: 1, createdAt: -1 });

const Shop = mongoose.model('Shop', shopSchema);
const User = mongoose.model('User', userSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const Audit = mongoose.model('Audit', auditSchema);
const PayrollPeriod = mongoose.model('PayrollPeriod', payrollPeriodSchema);
const PayrollAdjustment = mongoose.model('PayrollAdjustment', adjustmentSchema);
const ShopClosure = mongoose.model('ShopClosure', closureSchema);
const Activity = mongoose.model('Activity', activitySchema);

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
  User.findById(req.session.userId).then(async (user) => {
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });
    req.user = user;
    req.session.role = user.role;
    if (req.path.endsWith('/logout')) return next();
    const membership = req.session.shopId && (user.role === 'owner'
      ? await Shop.exists({ _id: req.session.shopId, ownerUserId: user._id })
      : await Employee.exists({ shopId: req.session.shopId, userId: user._id, active: true }));
    if (!membership) {
      const shopSetupRoute = user.role === 'owner' && req.path === '/api/shops' &&
        ['GET', 'POST'].includes(req.method) &&
        !await Shop.exists({ ownerUserId: user._id });
      if (shopSetupRoute) return next();
      return res.status(403).json({ error: 'Choose a shop you have access to.' });
    }
    next();
  }).catch(next);
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

async function accessibleShops(user) {
  if (user.role === 'owner') {
    return Shop.find({ ownerUserId: user._id }).sort({ name: 1 }).lean();
  }
  const assignments = await Employee.find({ userId: user._id, active: true }).sort({ createdAt: 1 }).populate('shopId').lean();
  return assignments.map((assignment) => assignment.shopId).filter(Boolean);
}

async function isFinalizedMonth(shopId, month) {
  return Boolean(await PayrollPeriod.exists({ shopId, month, finalizedAt: { $ne: null } }));
}

async function requirePayrollConfirmation(req, res, month) {
  if (!await isFinalizedMonth(req.session.shopId, month) || req.body.confirmFinalizedMonth === true) return true;
  res.status(409).json({
    code: 'MONTH_FINALIZED',
    error: `Payroll for ${month} is finalized. Confirm to apply this change; the payroll report will reflect the update.`,
  });
  return false;
}

async function markFinalizedMonthChanged(shopId, month, actor) {
  await PayrollPeriod.updateOne(
    { shopId, month, finalizedAt: { $ne: null } },
    { $set: { lastChangeAt: new Date(), lastChangeBy: actor } },
  );
}

async function logActivity({ shopId, month, action, description, actor }) {
  await Activity.create({ shopId, month, action, description, actor });
}

function payrollEmployeeSummary(employee, records, adjustments, closures, month) {
  const datesInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const allowance = employee.leaveOverrides.get(month) ?? employee.monthlyLeaveAllowance;
  const dailyShare = Number((employee.rate / Math.max(1, datesInMonth - allowance)).toFixed(2));
  const presentDays = records.filter((record) => record.status === 'present').length;
  const halfDays = records.filter((record) => record.status === 'half').length;
  const paidLeaveDays = records.filter((record) => record.status === 'paid').length;
  const unpaidLeaveDays = records.filter((record) => record.status === 'unpaid').length;
  const unpaidLeaveDeduction = employee.payType === 'monthly'
    ? records.reduce((sum, record) => sum + (record.status === 'unpaid' ? record.deductionAmount ?? dailyShare : 0), 0)
    : 0;
  const paidClosureDays = closures.filter((closure) => closure.payTreatment === 'paid').length;
  const unpaidClosureDays = closures.length - paidClosureDays;
  const closureDeduction = employee.payType === 'monthly'
    ? Number((dailyShare * unpaidClosureDays).toFixed(2))
    : 0;
  const grossWage = employee.payType === 'monthly'
    ? employee.rate
    : Number(((presentDays + halfDays * 0.5 + paidClosureDays) * employee.rate).toFixed(2));
  const activeAdjustments = adjustments.filter((adjustment) => !adjustment.voidedAt);
  const advances = activeAdjustments.filter((adjustment) => adjustment.type === 'advance').reduce((sum, item) => sum + item.amount, 0);
  const bonuses = activeAdjustments.filter((adjustment) => adjustment.type === 'bonus').reduce((sum, item) => sum + item.amount, 0);
  const otherDeductions = activeAdjustments.filter((adjustment) => adjustment.type === 'deduction').reduce((sum, item) => sum + item.amount, 0);
  const totalDeductions = Number((unpaidLeaveDeduction + closureDeduction + advances + otherDeductions).toFixed(2));
  const finalPay = Number(Math.max(0, grossWage + bonuses - totalDeductions).toFixed(2));
  return {
    employeeId: employee._id.toString(),
    employeeName: employee.name,
    payType: employee.payType,
    rate: employee.rate,
    presentDays,
    halfDays,
    paidLeaveDays,
    unpaidLeaveDays,
    paidClosureDays,
    unpaidClosureDays,
    grossWage: Number(grossWage.toFixed(2)),
    unpaidLeaveDeduction: Number(unpaidLeaveDeduction.toFixed(2)),
    closureDeduction,
    advances: Number(advances.toFixed(2)),
    bonuses: Number(bonuses.toFixed(2)),
    otherDeductions: Number(otherDeductions.toFixed(2)),
    totalDeductions,
    finalPay,
  };
}

async function calculatePayrollRows(shopId, month) {
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31`;
  const [employees, attendance, adjustments, closures] = await Promise.all([
    Employee.find({ shopId, active: true }).sort({ name: 1 }),
    Attendance.find({ shopId, date: { $gte: monthStart, $lte: monthEnd } }).lean(),
    PayrollAdjustment.find({ shopId, month }).lean(),
    ShopClosure.find({ shopId, date: { $gte: monthStart, $lte: monthEnd }, active: true }).sort({ date: 1 }).lean(),
  ]);
  const attendanceByEmployee = new Map();
  for (const record of attendance) {
    const employeeId = record.employeeId.toString();
    if (!attendanceByEmployee.has(employeeId)) attendanceByEmployee.set(employeeId, []);
    attendanceByEmployee.get(employeeId).push(record);
  }
  const adjustmentsByEmployee = new Map();
  for (const adjustment of adjustments) {
    const employeeId = adjustment.employeeId.toString();
    if (!adjustmentsByEmployee.has(employeeId)) adjustmentsByEmployee.set(employeeId, []);
    adjustmentsByEmployee.get(employeeId).push(adjustment);
  }
  return employees.map((employee) => payrollEmployeeSummary(
    employee,
    attendanceByEmployee.get(employee._id.toString()) ?? [],
    adjustmentsByEmployee.get(employee._id.toString()) ?? [],
    closures,
    month,
  ));
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
  req.session.role = user.role;
  let shops = await accessibleShops(user);
  if (!shops.some((shop) => shop._id.toString() === req.session.shopId)) {
    if (!shops.length && user.role !== 'owner') return res.status(403).json({ error: 'No active shop is assigned to this account.' });
    req.session.shopId = shops[0]?._id.toString() ?? '';
  }
  const token = await makeCsrfToken(req, res);
  const payload = {
    authenticated: true,
    csrfToken: token,
    role: user.role,
    name: user.displayName,
    shops: shops.map((shop) => ({ id: shop._id.toString(), name: shop.name })),
    activeShopId: req.session.shopId,
  };
  if (user.role === 'owner' && req.session.shopId) {
    const shop = await getShop(req);
    payload.currency = shop?.currency ?? 'INR';
  } else if (user.role === 'worker') {
    const employee = await Employee.findOne({ userId: user._id, shopId: req.session.shopId, active: true }).lean();
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
  const { name, username, password, shopName = 'Main shop' } = req.body;
  if (!validName(name) || !validUsername(username) || !validPassword(password)) {
    return res.status(400).json({ error: 'Enter a name, a username (3–40 letters/numbers/._-), and a password of at least 8 characters.' });
  }
  if (!validName(shopName)) return res.status(400).json({ error: 'Enter a valid shop name.' });
  const ownerId = new mongoose.Types.ObjectId();
  const shop = await Shop.create({
    _id: new mongoose.Types.ObjectId(),
    name: shopName.trim(),
    ownerUserId: ownerId,
    ownerName: name.trim(),
  });
  try {
    const user = await User.create({
      _id: ownerId,
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
  const shops = await accessibleShops(user);
  if (!shops.length && user.role !== 'owner') return res.status(403).json({ error: 'No shop is assigned to this account.' });
  const defaultShopId = user.role === 'owner'
    ? (shops.find((shop) => shop._id.toString() === user.shopId?.toString())?._id ?? shops[0]?._id ?? '')
    : shops[0]._id;
  req.session.regenerate((error) => {
    if (error) return res.status(500).json({ error: 'Could not start your session.' });
    req.session.userId = user._id.toString();
    req.session.shopId = defaultShopId ? defaultShopId.toString() : '';
    req.session.role = user.role;
    csrfToken(req);
    req.session.save((saveError) => {
      if (saveError) return res.status(500).json({ error: 'Could not save your session.' });
      res.json({ ok: true });
    });
  });
}));

app.get('/api/shops', requireAuth, asyncRoute(async (req, res) => {
  const shops = await accessibleShops(req.user);
  res.json({
    activeShopId: req.session.shopId,
    shops: shops.map((shop) => ({ id: shop._id.toString(), name: shop.name })),
  });
}));

app.post('/api/shops', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { name } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Enter a shop name up to 80 characters.' });
  const shop = await Shop.create({
    name: name.trim(),
    ownerUserId: req.user._id,
    ownerName: req.user.displayName,
  });
  req.session.shopId = shop._id.toString();
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.status(201).json({ id: shop._id.toString(), name: shop.name });
}));

app.patch('/api/shops/active', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { name } = req.body;
  if (!validName(name)) return res.status(400).json({ error: 'Enter a shop name up to 80 characters.' });
  const shop = await Shop.findOneAndUpdate(
    { _id: req.session.shopId, ownerUserId: req.user._id },
    { $set: { name: name.trim() } },
    { new: true, runValidators: true },
  );
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  res.json({ id: shop._id.toString(), name: shop.name });
}));

app.post('/api/shops/active', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
  const { shopId } = req.body;
  if (!mongoose.isValidObjectId(shopId)) return res.status(400).json({ error: 'Choose a valid shop.' });
  const membership = req.user.role === 'owner'
    ? await Shop.exists({ _id: shopId, ownerUserId: req.user._id })
    : await Employee.exists({ shopId, userId: req.user._id, active: true });
  if (!membership) return res.status(403).json({ error: 'You do not have access to that shop.' });
  req.session.shopId = shopId;
  await new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  res.json({ ok: true, activeShopId: shopId });
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
    return res.json({ name: shop.name, currency: shop.currency, employees: [workerJson(employee, month)] });
  }
  const month = validMonth(req.query.month) ? req.query.month : new Date().toISOString().slice(0, 7);
  const employees = await Employee.find({ shopId: req.session.shopId, active: true }).populate('userId', 'username').sort({ name: 1 });
  res.json({ name: shop.name, currency: shop.currency, employees: employees.map((employee) => workerJson(employee, month)) });
}));

app.post('/api/workers', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { name, username, password, payType, rate, monthlyLeaveAllowance, month, allowanceThisMonth } = req.body;
  if (!validName(name) || !validUsername(username) ||
      !['daily', 'monthly'].includes(payType) || !Number.isFinite(rate) || rate < 0 ||
      !Number.isInteger(monthlyLeaveAllowance) || monthlyLeaveAllowance < 0 || monthlyLeaveAllowance > 31 ||
      !validMonth(month) || !Number.isInteger(allowanceThisMonth) || allowanceThisMonth < 0 || allowanceThisMonth > 31) {
    return res.status(400).json({ error: 'Check the worker details, pay rate, and monthly leave allowance.' });
  }
  const normalizedUsername = username.trim().toLowerCase();
  const existingUser = await User.findOne({ username: normalizedUsername });
  if (existingUser?.role === 'owner') return res.status(409).json({ error: 'That username belongs to an owner account.' });
  if (!validPassword(password)) {
    return res.status(400).json({ error: 'Enter a password of at least 8 characters to create a login or verify an existing worker.' });
  }
  if (existingUser && !(await bcrypt.compare(password, existingUser.passwordHash))) {
    return res.status(401).json({ error: 'That password does not match the existing worker account.' });
  }
  if (!await requirePayrollConfirmation(req, res, month)) return;
  const actor = await User.findById(req.session.userId).select('displayName').lean();
  if (!actor) return res.status(401).json({ error: 'Please sign in again.' });
  let employee = existingUser
    ? await Employee.findOne({ shopId: req.session.shopId, userId: existingUser._id })
    : null;
  if (employee?.active) return res.status(409).json({ error: 'This worker is already assigned to the selected shop.' });
  employee ??= new Employee({
    shopId: req.session.shopId,
    userId: existingUser?._id ?? new mongoose.Types.ObjectId(),
  });
  employee.set({
    name: name.trim(),
    payType,
    rate,
    monthlyLeaveAllowance,
    leaveOverrides: { [month]: allowanceThisMonth },
    active: true,
  });
  let createdUser = false;
  try {
    let user = existingUser;
    if (!user) {
      user = await User.create({
        _id: employee.userId,
        shopId: req.session.shopId,
        role: 'worker',
        displayName: employee.name,
        username: normalizedUsername,
        passwordHash: await bcrypt.hash(password, 12),
        employeeId: employee._id,
      });
      createdUser = true;
    }
    await employee.save();
    await markFinalizedMonthChanged(req.session.shopId, month, actor.displayName);
    await logActivity({
      shopId: req.session.shopId,
      month,
      action: 'worker_added',
      description: `Worker ${employee.name} was added.`,
      actor: actor.displayName,
    });
    res.status(201).json(workerJson({ ...employee.toObject(), user: { username: user.username } }, month));
  } catch (error) {
    if (createdUser) await User.deleteOne({ _id: employee.userId });
    if (error.code === 11000) return res.status(409).json({ error: 'That username is already in use or assigned to this shop.' });
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
  if (!await requirePayrollConfirmation(req, res, month)) return;
  const employee = await Employee.findOne({ _id: req.params.id, shopId: req.session.shopId, active: true });
  if (!employee) return res.status(404).json({ error: 'Worker not found.' });
  const user = await User.findOne({ _id: employee.userId, role: 'worker' });
  if (!user) return res.status(404).json({ error: 'Worker account not found.' });
  employee.name = name.trim();
  employee.payType = payType;
  employee.rate = rate;
  employee.monthlyLeaveAllowance = monthlyLeaveAllowance;
  employee.leaveOverrides.set(month, allowanceThisMonth);
  user.username = username.trim().toLowerCase();
  if (password) user.passwordHash = await bcrypt.hash(password, 12);
  try {
    await Promise.all([employee.save(), user.save()]);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'That username is already in use.' });
    throw error;
  }
  await markFinalizedMonthChanged(req.session.shopId, month, user.displayName);
  await logActivity({
    shopId: req.session.shopId,
    month,
    action: 'worker_pay_updated',
    description: `Pay or leave settings updated for ${employee.name}.`,
    actor: user.displayName,
  });
  res.json(workerJson({ ...employee.toObject(), user: { username: user.username } }, month));
}));

app.patch('/api/settings', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  if (!CURRENCIES.includes(req.body.currency)) return res.status(400).json({ error: 'Choose a supported currency.' });
  const shop = await Shop.findByIdAndUpdate(req.session.shopId, { currency: req.body.currency }, { new: true });
  if (!shop) return res.status(404).json({ error: 'Shop not found.' });
  res.json({ currency: shop.currency });
}));

app.get('/api/payroll', requireAuth, requireOwner, asyncRoute(async (req, res) => {
  const { month } = req.query;
  if (!validMonth(month)) return res.status(400).json({ error: 'Choose a valid month.' });
  const [calculatedEmployees, adjustments, closures, period, activity] = await Promise.all([
    calculatePayrollRows(req.session.shopId, month),
    PayrollAdjustment.find({ shopId: req.session.shopId, month }).sort({ createdAt: -1 }).lean(),
    ShopClosure.find({ shopId: req.session.shopId, date: { $gte: `${month}-01`, $lte: `${month}-31` }, active: true }).sort({ date: 1 }).lean(),
    PayrollPeriod.findOne({ shopId: req.session.shopId, month }).lean(),
    Activity.find({ shopId: req.session.shopId, month }).sort({ createdAt: -1 }).limit(100).lean(),
  ]);
  res.json({
    month,
    finalizedAt: period?.finalizedAt?.toISOString() ?? null,
    finalizedBy: period?.finalizedBy ?? '',
    lastChangeAt: period?.lastChangeAt?.toISOString() ?? null,
    lastChangeBy: period?.lastChangeBy ?? '',
    employees: period?.finalizedAt && !period.lastChangeAt && period.snapshot?.length
      ? period.snapshot
      : calculatedEmployees,
    adjustments: adjustments.map((item) => ({
      id: item._id.toString(),
      employeeId: item.employeeId.toString(),
      month: item.month,
      type: item.type,
      amount: item.amount,
      note: item.note,
      actor: item.actor,
      createdAt: item.createdAt.toISOString(),
      voidedAt: item.voidedAt?.toISOString() ?? null,
      voidedBy: item.voidedBy ?? '',
    })),
    closures: closures.map((item) => ({
      id: item._id.toString(),
      date: item.date,
      seriesId: item.seriesId,
      label: item.label,
      type: item.type,
      payTreatment: item.payTreatment,
      actor: item.actor,
      createdAt: item.createdAt.toISOString(),
    })),
    activity: activity.map((item) => ({
      action: item.action,
      description: item.description,
      actor: item.actor,
      timestamp: item.createdAt.toISOString(),
    })),
  });
}));

app.post('/api/payroll/finalize', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { month } = req.body;
  if (!validMonth(month)) return res.status(400).json({ error: 'Choose a valid month.' });
  const actor = await User.findById(req.session.userId).select('displayName').lean();
  if (!actor) return res.status(401).json({ error: 'Please sign in again.' });
  const wasFinalized = await isFinalizedMonth(req.session.shopId, month);
  const snapshot = await calculatePayrollRows(req.session.shopId, month);
  const period = await PayrollPeriod.findOneAndUpdate(
    { shopId: req.session.shopId, month },
    { $set: { finalizedAt: new Date(), finalizedBy: actor.displayName, lastChangeAt: null, lastChangeBy: '', snapshot } },
    { upsert: true, new: true, runValidators: true },
  );
  await logActivity({
    shopId: req.session.shopId,
    month,
    action: 'payroll_finalized',
    description: wasFinalized ? 'Payroll was reviewed and finalized again.' : 'Payroll was reviewed and finalized.',
    actor: actor.displayName,
  });
  res.json({ finalizedAt: period.finalizedAt.toISOString(), finalizedBy: period.finalizedBy });
}));

app.post('/api/payroll/adjustments', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { month, employeeId, type, amount, note = '' } = req.body;
  if (!validMonth(month) || !mongoose.isValidObjectId(employeeId) ||
      !['advance', 'bonus', 'deduction'].includes(type) ||
      !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
      typeof note !== 'string' || note.trim().length > 200) {
    return res.status(400).json({ error: 'Enter a worker, adjustment type, positive amount, valid month, and a note under 200 characters.' });
  }
  if (!await requirePayrollConfirmation(req, res, month)) return;
  const [employee, actor] = await Promise.all([
    Employee.findOne({ _id: employeeId, shopId: req.session.shopId, active: true }).select('name'),
    User.findById(req.session.userId).select('displayName'),
  ]);
  if (!employee) return res.status(404).json({ error: 'Worker not found.' });
  if (!actor) return res.status(401).json({ error: 'Please sign in again.' });
  const adjustment = await PayrollAdjustment.create({
    shopId: req.session.shopId,
    employeeId,
    month,
    type,
    amount,
    note: note.trim(),
    actor: actor.displayName,
  });
  await markFinalizedMonthChanged(req.session.shopId, month, actor.displayName);
  await logActivity({
    shopId: req.session.shopId,
    month,
    action: 'adjustment_added',
    description: `${type} for ${employee.name}: ${amount.toFixed(2)}${note.trim() ? ` (${note.trim()})` : ''}.`,
    actor: actor.displayName,
  });
  res.status(201).json({ id: adjustment._id.toString() });
}));

app.delete('/api/payroll/adjustments/:id', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Choose a valid adjustment.' });
  const adjustment = await PayrollAdjustment.findOne({ _id: req.params.id, shopId: req.session.shopId, voidedAt: null });
  if (!adjustment) return res.status(404).json({ error: 'Adjustment not found.' });
  if (!await requirePayrollConfirmation(req, res, adjustment.month)) return;
  const actor = await User.findById(req.session.userId).select('displayName').lean();
  if (!actor) return res.status(401).json({ error: 'Please sign in again.' });
  adjustment.voidedAt = new Date();
  adjustment.voidedBy = actor.displayName;
  await adjustment.save();
  await markFinalizedMonthChanged(req.session.shopId, adjustment.month, actor.displayName);
  await logActivity({
    shopId: req.session.shopId,
    month: adjustment.month,
    action: 'adjustment_voided',
    description: `${adjustment.type} for ${adjustment.amount.toFixed(2)} was voided.`,
    actor: actor.displayName,
  });
  res.json({ ok: true });
}));

app.get('/api/closures', requireAuth, asyncRoute(async (req, res) => {
  const { month } = req.query;
  if (!validMonth(month)) return res.status(400).json({ error: 'Choose a valid month.' });
  const closures = await ShopClosure.find({
    shopId: req.session.shopId,
    date: { $gte: `${month}-01`, $lte: `${month}-31` },
    active: true,
  }).sort({ date: 1 }).lean();
  res.json({
    closures: closures.map((closure) => ({
      id: closure._id.toString(),
      date: closure.date,
      label: closure.label,
      type: closure.type,
      payTreatment: closure.payTreatment,
    })),
  });
}));

app.post('/api/closures', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  const { date, label, type, payTreatment, repeatWeekly = false } = req.body;
  if (!validDate(date) || !validName(label) ||
      !['holiday', 'weekly_off'].includes(type) ||
      !['paid', 'unpaid'].includes(payTreatment) ||
      typeof repeatWeekly !== 'boolean' || (repeatWeekly && type !== 'weekly_off')) {
    return res.status(400).json({ error: 'Enter a valid date, closure name, closure type, and pay treatment.' });
  }
  const month = date.slice(0, 7);
  if (!await requirePayrollConfirmation(req, res, month)) return;
  const actor = await User.findById(req.session.userId).select('displayName').lean();
  if (!actor) return res.status(401).json({ error: 'Please sign in again.' });
  const dates = [date];
  if (repeatWeekly) {
    const dateObject = new Date(`${date}T12:00:00Z`);
    const monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
    for (let day = dateObject.getUTCDate() + 7; day <= monthEnd; day += 7) {
      dates.push(`${month}-${String(day).padStart(2, '0')}`);
    }
  }
  if (await ShopClosure.exists({ shopId: req.session.shopId, date: { $in: dates }, active: true })) {
    return res.status(409).json({ error: 'A closure is already set on one or more selected dates.' });
  }
  if (await Attendance.exists({ shopId: req.session.shopId, date: { $in: dates } })) {
    return res.status(409).json({ error: 'Clear attendance entries on the selected date(s) before adding a shop closure.' });
  }
  const seriesId = repeatWeekly ? crypto.randomUUID() : '';
  await ShopClosure.insertMany(dates.map((closureDate) => ({
    shopId: req.session.shopId,
    date: closureDate,
    seriesId,
    label: label.trim(),
    type,
    payTreatment,
    actor: actor.displayName,
  })));
  await markFinalizedMonthChanged(req.session.shopId, month, actor.displayName);
  await logActivity({
    shopId: req.session.shopId,
    month,
    action: 'closure_added',
    description: `${label.trim()} added for ${dates.length} ${dates.length === 1 ? 'date' : 'dates'} as ${payTreatment}.`,
    actor: actor.displayName,
  });
  res.status(201).json({ dates });
}));

app.delete('/api/closures/:id', requireAuth, requireCsrf, requireOwner, asyncRoute(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Choose a valid closure.' });
  const closure = await ShopClosure.findOne({ _id: req.params.id, shopId: req.session.shopId, active: true });
  if (!closure) return res.status(404).json({ error: 'Closure not found.' });
  const month = closure.date.slice(0, 7);
  if (!await requirePayrollConfirmation(req, res, month)) return;
  const actor = await User.findById(req.session.userId).select('displayName').lean();
  if (!actor) return res.status(401).json({ error: 'Please sign in again.' });
  closure.voidedAt = new Date();
  closure.voidedBy = actor.displayName;
  closure.active = false;
  await closure.save();
  await markFinalizedMonthChanged(req.session.shopId, month, actor.displayName);
  await logActivity({
    shopId: req.session.shopId,
    month,
    action: 'closure_removed',
    description: `${closure.label} on ${closure.date} was removed.`,
    actor: actor.displayName,
  });
  res.json({ ok: true });
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
  const month = uniqueDates[0].slice(0, 7);
  if (!await requirePayrollConfirmation(req, res, month)) return;
  if (await ShopClosure.exists({ shopId: req.session.shopId, date: { $in: uniqueDates }, active: true })) {
    res.status(409).json({ error: 'A shop closure is set on one or more selected dates. Remove the closure before marking attendance.' });
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
  if (changedCount && await isFinalizedMonth(req.session.shopId, month)) {
    await markFinalizedMonthChanged(req.session.shopId, month, actor.displayName);
    await logActivity({
      shopId: req.session.shopId,
      month,
      action: 'finalized_payroll_changed',
      description: `Attendance changed for ${employee.name} after payroll finalization.`,
      actor: actor.displayName,
    });
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

async function prepareMultiShopData() {
  const owner = await User.findOne({ role: 'owner' }).select('_id').lean();
  if (owner) {
    await Shop.updateMany(
      { ownerUserId: { $exists: false } },
      { $set: { ownerUserId: owner._id } },
    );
  }
  await Shop.updateMany(
    { name: { $exists: false } },
    { $set: { name: 'Main shop' } },
  );

  for (const [collection, obsoleteIndex] of [
    [User.collection, (index) => index.unique && index.key?.role === 1],
    [Employee.collection, (index) => index.unique && Object.keys(index.key ?? {}).join(',') === 'userId'],
  ]) {
    let indexes = [];
    try {
      indexes = await collection.indexes();
    } catch (error) {
      if (error.codeName !== 'NamespaceNotFound') throw error;
    }
    for (const index of indexes.filter(obsoleteIndex)) {
      await collection.dropIndex(index.name);
    }
  }
  await Employee.collection.createIndex({ shopId: 1, userId: 1 }, { unique: true });
  await Shop.collection.createIndex({ ownerUserId: 1 });
}

mongoose.connect(mongoUri)
  .then(prepareMultiShopData)
  .then(() => app.listen(port, () => console.log(`Daymark is ready at http://localhost:${port}`)))
  .catch((error) => {
    console.error('Could not connect to MongoDB:', error.message);
    process.exit(1);
  });
