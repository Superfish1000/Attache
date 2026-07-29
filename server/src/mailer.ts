import nodemailer from 'nodemailer'
import { db } from './store.js'
import { createResetToken } from './auth.js'
import type { User } from './types.js'

export function emailConfigured(): boolean {
  const e = db.settings.email
  return Boolean(e.host && e.from)
}

function transport() {
  const e = db.settings.email
  return nodemailer.createTransport({
    host: e.host,
    port: e.port,
    secure: e.secure,
    ...(e.user ? { auth: { user: e.user, pass: e.pass } } : {}),
  })
}

export async function verifySmtp(): Promise<void> {
  if (!emailConfigured()) throw new Error('email is not configured (Settings → Email)')
  await transport().verify()
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!emailConfigured()) throw new Error('email is not configured (Settings → Email)')
  await transport().sendMail({ from: db.settings.email.from, to, subject, text })
}

/**
 * Creates a single-use set-password token and emails the link — one mechanism
 * for onboarding ('welcome') and recovery ('reset'), different wording.
 * Throws with a precise reason when email or the public URL is unconfigured —
 * both checked BEFORE the token is created, so unconfigured systems don't
 * accumulate orphan tokens.
 */
export async function sendSetPasswordEmail(user: User, kind: 'welcome' | 'reset'): Promise<void> {
  if (!emailConfigured()) throw new Error('email is not configured (Settings → Email)')
  const base = db.settings.server.publicBaseUrl.trim().replace(/\/+$/, '')
  if (!base) throw new Error('public GUI address is not set (Settings → Server)')
  const link = `${base}/reset?token=${createResetToken(user.id)}`
  const subject = kind === 'welcome' ? 'Your Attaché agent is ready' : 'Attaché password reset'
  const intro =
    kind === 'welcome'
      ? `Hi ${user.name},\n\nAn Attaché account and agent have been created for you.`
      : `Hi ${user.name},\n\nA password reset was requested for your Attaché account.`
  await sendMail(
    user.email,
    subject,
    `${intro}\n\nSet your password here (the link expires in 48 hours and works once):\n\n${link}\n\nIf you weren't expecting this email you can ignore it.`,
  )
}
