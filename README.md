# Daymark shop attendance

A small Node/Express app with MongoDB-backed owner and worker accounts, attendance history, monthly paid-leave limits, and wage estimates.

## Requirements

- Node.js 20 or newer
- A MongoDB Atlas database (or another MongoDB connection string)

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. In MongoDB Atlas, create a database user and allow the IP address of the machine running this app in **Network Access**. Keep the database password and connection string private.
4. Replace `MONGODB_URI` in `.env` with the connection string from Atlas. URL-encode special characters in the database username or password.
5. Set `SESSION_SECRET` and `OWNER_SETUP_TOKEN` to different random values, at least 32 characters each. For example, generate each with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
6. Start the app using `npm start`, then open `http://localhost:3000`.
7. For first-time owner setup, open `http://localhost:3000/owner-setup` and enter the `OWNER_SETUP_TOKEN` from `.env`. The setup page is not linked from the sign-in page and becomes unavailable after an owner has been created.
8. Sign in as the owner and add worker accounts. Give each worker their username and a temporary password.

Do not share `.env`, the setup token, database credentials, or worker passwords. Use HTTPS and a strong setup token when hosting outside your computer. Owner and worker access is enforced by the server; hiding controls in the page is not the security boundary.

## Monthly leave and wages

- Each worker has a normal monthly paid-leave allowance. The owner can set a separate allowance for the displayed month to carry days forward manually; unused leave is never carried automatically, and a one-month adjustment does not change future months.
- Present counts as one worked day and Half day as half a worked day for daily-rate workers.
- Unpaid leave reduces a fixed monthly wage by one day’s share: monthly wage ÷ (calendar days in that month − paid-leave allowance). The owner can override the deduction per day. Paid leave does not reduce fixed monthly wages.
- Owners can mark a date range or individually selected dates at once. Replacing existing attendance requires a second confirmation, and every change is added to the audit history.
- Fixed-monthly wage estimates show the monthly wage less unpaid-leave deductions. Daily-rate estimates count Present as a full day and Half day as half a day.
- Worker-submitted attendance counts immediately. Owners can review and edit any worker's entries; changes appear in the audit history.

This app is a lightweight shop register, not payroll or statutory leave software. Verify wage calculations and local employment requirements before using totals for payment.
