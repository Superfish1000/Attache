import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstFromImage, parseImageRef } from './image-updates.js'

test('parseImageRef: bare name is a Docker Hub "library/" official image', () => {
  assert.deepEqual(parseImageRef('alpine:3.19'), {
    registryHost: 'registry-1.docker.io',
    repo: 'library/alpine',
    tag: '3.19',
  })
})

test('parseImageRef: namespaced Docker Hub image needs no "library/" prefix', () => {
  assert.deepEqual(parseImageRef('nousresearch/hermes-agent:latest'), {
    registryHost: 'registry-1.docker.io',
    repo: 'nousresearch/hermes-agent',
    tag: 'latest',
  })
})

test('parseImageRef: missing tag defaults to latest', () => {
  assert.deepEqual(parseImageRef('nousresearch/hermes-agent'), {
    registryHost: 'registry-1.docker.io',
    repo: 'nousresearch/hermes-agent',
    tag: 'latest',
  })
})

test('parseImageRef: a dotted first segment is a custom registry host', () => {
  assert.deepEqual(parseImageRef('ghcr.io/owner/repo:v1'), {
    registryHost: 'ghcr.io',
    repo: 'owner/repo',
    tag: 'v1',
  })
})

test('parseImageRef: a port in the host is not mistaken for the tag separator', () => {
  assert.deepEqual(parseImageRef('localhost:5000/myimage:dev'), {
    registryHost: 'localhost:5000',
    repo: 'myimage',
    tag: 'dev',
  })
})

test('firstFromImage: plain FROM line', () => {
  assert.equal(firstFromImage('FROM alpine:3.19\nRUN echo hi'), 'alpine:3.19')
})

test('firstFromImage: tolerates a leading comment line', () => {
  assert.equal(firstFromImage('# syntax note\nFROM nousresearch/hermes-agent:latest\nRUN echo hi'), 'nousresearch/hermes-agent:latest')
})

test('firstFromImage: no FROM line returns null', () => {
  assert.equal(firstFromImage('RUN echo hi'), null)
})

test('firstFromImage: empty dockerfile returns null', () => {
  assert.equal(firstFromImage(''), null)
})
