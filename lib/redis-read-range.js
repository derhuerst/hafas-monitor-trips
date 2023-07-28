const redisReadRange = async function* (redis, prefix) {
	let cursor = '0'
	while (true) { // eslint-disable-line no-constant-condition
		const [
			newCursor, keys,
		] = await redis.scan(cursor, 'COUNT', 300, 'MATCH', prefix + '*')
		cursor = newCursor

		const op = redis.multi()
		for (const key of keys) op.get(key)
		const res = await op.exec()
		for (let i = 0; i < res.length; i++) {
			const [err, val] = res[i]
			if (err) throw err
			yield [keys[i], val]
		}
		if (cursor === '0') break
	}
}

export {
	redisReadRange,
}
