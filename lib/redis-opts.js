'use strict'

const opts = {}

if (process.env.REDIS_URL) {
	const url = new URL(process.env.REDIS_URL)
	opts.host = url.hostname || 'localhost'
	opts.port = url.port || '6379'
	if (url.password) opts.password = url.password
	if (url.pathname && url.pathname.length > 1) {
		opts.db = parseInt(url.pathname.slice(1))
	}
}

module.exports = opts
