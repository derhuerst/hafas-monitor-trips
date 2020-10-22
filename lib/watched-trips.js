'use strict'

const TRIPS_KEY = 'v1-trips'

const createWatchedTripsSet = (redis, ttl) => {
	const NS = TRIPS_KEY + '!'

	const put = async (tripId, lineName) => {
		await redis.set(NS + tripId, lineName, 'PX', ttl)
	}

	const del = async (tripId) => {
		await redis.del(NS + tripId)
	}

	const entries = async function* () {
		let cursor = '0'
		while (true) {
			const [
				newCursor, keys,
			] = await redis.scan(cursor, 'COUNT', 300, 'MATCH', NS + '*')
			cursor = newCursor

			const op = redis.multi()
			for (const key of keys) op.get(key)
			const res = await op.exec()
			for (let i = 0; i < res.length; i++) {
				const [err, lineName] = res[i]
				if (err) throw err // err?
				if (lineName === null) continue
				yield [
					keys[i].slice(NS.length),
					lineName,
				]
			}

			if (cursor === '0') break
		}
	}

	const count = async () => {
		let count = 0
		let cursor = '0'
		while (true) { // eslint-disable-line no-constant-condition
			const [newCursor, keys] = await redis.scan(cursor, 'COUNT', 300, 'MATCH', NS + '*')
			count += keys.length
			cursor = newCursor
			if (cursor === '0') break
		}
		return count
	}

	return {
		put,
		del,
		entries,
		count,
	}
}

module.exports = createWatchedTripsSet
