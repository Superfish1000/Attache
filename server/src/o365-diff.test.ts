import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffMembership } from './o365-diff.js'
import type { GraphMember } from './o365.js'
import type { User } from './types.js'

const member = (id: string, mail: string): GraphMember => ({
  id,
  displayName: mail.split('@')[0],
  mail,
  userPrincipalName: mail,
})

const user = (over: Partial<User>): User =>
  ({
    id: 'u-' + Math.random().toString(36).slice(2, 8),
    name: 'Test',
    email: 'test@example.com',
    role: 'standard',
    source: 'o365',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as User

test('unknown members are created', () => {
  const d = diffMembership([member('m1', 'new@corp.com')], [])
  assert.equal(d.toCreate.length, 1)
  assert.equal(d.toCreate[0].id, 'm1')
})

test('members matched by o365Id or email are not created', () => {
  const users = [
    user({ o365Id: 'm1', email: 'a@corp.com' }),
    user({ email: 'b@corp.com' }), // email match only
  ]
  const d = diffMembership([member('m1', 'a@corp.com'), member('m2', 'B@CORP.COM')], users)
  assert.equal(d.toCreate.length, 0)
})

test('vanished o365 user is disabled', () => {
  const u = user({ o365Id: 'm1', email: 'gone@corp.com' })
  const d = diffMembership([], [u])
  assert.deepEqual(d.toDisable, [u])
})

test('vanished admin is skipped, never disabled', () => {
  const u = user({ o365Id: 'm1', role: 'admin' })
  const d = diffMembership([], [u])
  assert.equal(d.toDisable.length, 0)
  assert.deepEqual(d.skippedAdmins, [u])
})

test('manual-source users are never disabled', () => {
  const u = user({ source: 'manual', email: 'local@corp.com' })
  const d = diffMembership([], [u])
  assert.equal(d.toDisable.length, 0)
  assert.equal(d.skippedAdmins.length, 0)
})

test('already-disabled user back in the group is re-enabled', () => {
  const u = user({ o365Id: 'm1', disabled: true, email: 'back@corp.com' })
  const d = diffMembership([member('m1', 'back@corp.com')], [u])
  assert.deepEqual(d.toReenable, [u])
  assert.equal(d.toDisable.length, 0)
})

test('already-disabled user still gone stays untouched (no double-disable)', () => {
  const u = user({ o365Id: 'm1', disabled: true })
  const d = diffMembership([], [u])
  assert.equal(d.toDisable.length, 0)
  assert.equal(d.toReenable.length, 0)
})

test('disabled user with no o365Id is re-enabled by email match', () => {
  const u = user({ o365Id: undefined, disabled: true, email: 'mail-only@corp.com' })
  const d = diffMembership([member('mX', 'mail-only@corp.com')], [u])
  assert.deepEqual(d.toReenable, [u])
})

test('member with null mail matches users by userPrincipalName', () => {
  const m: GraphMember = { id: 'm9', displayName: null, mail: null, userPrincipalName: 'upn@corp.com' }
  const u = user({ email: 'upn@corp.com' })
  const d = diffMembership([m], [u])
  assert.equal(d.toCreate.length, 0)
})
