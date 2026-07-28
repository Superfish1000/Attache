/**
 * Emergency/bootstrap admin creation — runs against the data store directly.
 *
 *   npm run create-admin -- <email> <password> [name]
 *
 * Stop the Attache server first: it keeps the store in memory and would
 * overwrite this change on its next write.
 */
import { db, save } from '../store.js'
import { hashPassword, hermesHashPassword } from '../auth.js'
import { newId } from '../store.js'

const [email, password, name] = process.argv.slice(2)

if (!email?.includes('@') || !password) {
  console.error('usage: npm run create-admin -- <email> <password> [name]')
  process.exit(1)
}
if (password.length < 8) {
  console.error('password must be at least 8 characters')
  process.exit(1)
}

const existing = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase())
if (existing) {
  existing.role = 'admin'
  existing.passwordHash = hashPassword(password)
  existing.dashboardHash = hermesHashPassword(password)
  if (name?.trim()) existing.name = name.trim()
  save()
  console.log(`updated existing user '${existing.email}' — now admin with the new password`)
} else {
  db.users.push({
    id: newId(),
    name: name?.trim() || email.split('@')[0],
    email,
    role: 'admin',
    source: 'manual',
    passwordHash: hashPassword(password),
    dashboardHash: hermesHashPassword(password),
    createdAt: new Date().toISOString(),
  })
  save()
  console.log(`created admin '${email}'`)
}
console.log('restart the Attache server (if running) before signing in')
