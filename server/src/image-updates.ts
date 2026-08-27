import { runDocker } from './docker-build.js'

export interface ImageUpdateCheck {
  status: 'up-to-date' | 'behind' | 'unknown'
  /** The image reference actually checked (a Dockerfile's FROM image, or the definition's own image). */
  checkedImage: string
  localDigest?: string
  remoteDigest?: string
  error?: string
}

/** First `FROM <image>` line of a Dockerfile, or null if there isn't one. */
export function firstFromImage(dockerfile: string): string | null {
  const m = dockerfile.match(/^\s*FROM\s+(\S+)/im)
  return m ? m[1] : null
}

/**
 * Splits an image reference into registry host / repo path / tag, following
 * Docker's own resolution rules: no dot/colon/"localhost" in the first path
 * segment means Docker Hub, and a bare name (no "/") is a Docker Hub
 * "library/" official image.
 */
export function parseImageRef(ref: string): { registryHost: string; repo: string; tag: string } {
  let rest = ref
  let tag = 'latest'
  const lastSlash = rest.lastIndexOf('/')
  const lastColon = rest.lastIndexOf(':')
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1)
    rest = rest.slice(0, lastColon)
  }
  const firstSlash = rest.indexOf('/')
  let registryHost = 'registry-1.docker.io'
  let repo = rest
  if (firstSlash !== -1) {
    const firstSegment = rest.slice(0, firstSlash)
    if (firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost') {
      registryHost = firstSegment
      repo = rest.slice(firstSlash + 1)
    }
  }
  if (registryHost === 'registry-1.docker.io' && !repo.includes('/')) {
    repo = `library/${repo}`
  }
  return { registryHost, repo, tag }
}

const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ')

/**
 * Fetches the remote manifest digest for an image:tag via the registry's own
 * HTTP API, not the Docker CLI — `docker manifest inspect` fails on this
 * daemon's CLI version against the OCI-format manifests most images publish
 * now ("unsupported manifest media type"). Follows the standard
 * WWW-Authenticate Bearer challenge (works against Docker Hub, GHCR, Quay,
 * and most spec-compliant registries) for anonymous/public pulls; anything
 * requiring real credentials surfaces as an error, not a false result.
 */
async function fetchRemoteDigest(image: string): Promise<{ digest: string } | { error: string }> {
  const { registryHost, repo, tag } = parseImageRef(image)
  const manifestUrl = `https://${registryHost}/v2/${repo}/manifests/${tag}`
  try {
    let res = await fetch(manifestUrl, { method: 'HEAD', headers: { Accept: MANIFEST_ACCEPT } })
    if (res.status === 401) {
      const challenge = res.headers.get('www-authenticate')
      const m = challenge?.match(/Bearer (.+)/i)
      if (!m) return { error: 'registry requires authentication' }
      const params = Object.fromEntries(
        [...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v]),
      )
      if (!params.realm) return { error: 'unsupported auth challenge' }
      const tokenUrl = new URL(params.realm)
      if (params.service) tokenUrl.searchParams.set('service', params.service)
      if (params.scope) tokenUrl.searchParams.set('scope', params.scope)
      const tokenRes = await fetch(tokenUrl)
      if (!tokenRes.ok) return { error: `registry auth failed (${tokenRes.status}) — may need credentials` }
      const body = (await tokenRes.json()) as { token?: string; access_token?: string }
      const bearer = body.token ?? body.access_token
      if (!bearer) return { error: 'registry auth response had no token' }
      res = await fetch(manifestUrl, {
        method: 'HEAD',
        headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${bearer}` },
      })
    }
    if (!res.ok) return { error: `registry returned ${res.status}` }
    const digest = res.headers.get('docker-content-digest')
    if (!digest) return { error: 'registry response had no digest' }
    return { digest }
  } catch (err) {
    return { error: `couldn't reach registry: ${(err as Error).message}` }
  }
}

/** The locally-cached digest for image:tag, or null if it's never been pulled (only built/committed locally). */
async function localImageDigest(image: string): Promise<string | null> {
  const insp = await runDocker(['inspect', image, '--format', '{{json .RepoDigests}}'])
  if (insp.code !== 0) return null
  try {
    const digests = JSON.parse(insp.output.trim()) as string[]
    const repo = image.split(':')[0]
    const match = digests.find((d) => d.startsWith(`${repo}@`)) ?? digests[0]
    if (!match) return null
    const at = match.lastIndexOf('@')
    return at === -1 ? null : match.slice(at + 1)
  } catch {
    return null
  }
}

/** Compares the locally-cached image against the registry's current tag. On-demand only — never call this automatically/on a timer (registries rate-limit anonymous pulls). */
export async function checkImageUpdate(image: string): Promise<ImageUpdateCheck> {
  const remote = await fetchRemoteDigest(image)
  if ('error' in remote) return { status: 'unknown', checkedImage: image, error: remote.error }
  const local = await localImageDigest(image)
  if (!local) {
    return {
      status: 'unknown',
      checkedImage: image,
      remoteDigest: remote.digest,
      error: 'not pulled locally yet',
    }
  }
  return {
    status: local === remote.digest ? 'up-to-date' : 'behind',
    checkedImage: image,
    localDigest: local,
    remoteDigest: remote.digest,
  }
}
