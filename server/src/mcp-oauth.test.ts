import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { generateCodeChallenge, isSafeCimdUrl, verifyPkce } from './mcp-oauth.js'

const b64url = (buf: Buffer) => buf.toString('base64url')

test('verifyPkce: matching verifier/challenge (S256) passes', () => {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  assert.equal(verifyPkce(verifier, challenge), true)
})

test('verifyPkce: mismatched verifier fails', () => {
  const verifier = b64url(randomBytes(32))
  const wrongChallenge = b64url(createHash('sha256').update('not-the-verifier').digest())
  assert.equal(verifyPkce(verifier, wrongChallenge), false)
})

test('generateCodeChallenge matches the S256 formula used by verifyPkce', () => {
  const verifier = b64url(randomBytes(32))
  const challenge = generateCodeChallenge(verifier)
  assert.equal(verifyPkce(verifier, challenge), true)
})

test('isSafeCimdUrl: rejects non-HTTPS', () => {
  assert.equal(isSafeCimdUrl('http://example.com/client.json'), false)
})

test('isSafeCimdUrl: rejects loopback', () => {
  assert.equal(isSafeCimdUrl('https://127.0.0.1/client.json'), false)
  assert.equal(isSafeCimdUrl('https://localhost/client.json'), false)
})

test('isSafeCimdUrl: rejects private ranges', () => {
  assert.equal(isSafeCimdUrl('https://10.0.0.5/client.json'), false)
  assert.equal(isSafeCimdUrl('https://192.168.1.1/client.json'), false)
  assert.equal(isSafeCimdUrl('https://172.16.0.1/client.json'), false)
})

test('isSafeCimdUrl: rejects link-local', () => {
  assert.equal(isSafeCimdUrl('https://169.254.169.254/client.json'), false)
})

test('isSafeCimdUrl: accepts a plausible public HTTPS URL', () => {
  assert.equal(isSafeCimdUrl('https://example.com/.well-known/client.json'), true)
})

test('isSafeCimdUrl: rejects malformed URLs instead of throwing', () => {
  assert.equal(isSafeCimdUrl('not a url'), false)
})
