'use strict'

// bypass cached-hafas-client
// https://github.com/public-transport/cached-hafas-client/blob/224be372cebaa44a22732ebbcc67f98b93fb9c08/index.js#L13
const CACHED = Symbol.for('cached-hafas-client:cached')

const noCache = Object.freeze(Object.assign(Object.create(null), {
	[CACHED]: false,
}))

module.exports = noCache
