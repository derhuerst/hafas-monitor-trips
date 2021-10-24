'use strict'

const a = require('assert')
const tripsListSegmentsFilters = require('../lib/trips-list-segments-filters')

const mockProducts = [
	{id: 'foo', bitmasks: [1, 4]},
	{id: 'bar', bitmasks: [2]},
	{id: 'baz', bitmasks: [8, 16]},
]
const mockHafas = {
	profile: {
		products: mockProducts,
	},
}

const withOp = opName => ({line: {operator: {name: opName}}})

const lineNameOrFahrtNr0 = '*'
const opts0 = {}
const trips0 = [
	{},
	{},
	{},
	{},
]

const segments1 = tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr0, opts0, trips0)
a.deepStrictEqual(segments1, [{
	lineNameOrFahrtNr: lineNameOrFahrtNr0,
	opts: {...opts0, products: {foo:  true, bar: false, baz: false}},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr0,
	opts: {...opts0, products: {foo: false, bar:  true, baz: false}},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr0,
	opts: {...opts0, products: {foo: false, bar: false, baz:  true}},
}])

const lineNameOrFahrtNr1a = segments1[0].lineNameOrFahrtNr
const opts1a = segments1[0].opts
const trips1a = [
	withOp('OP 1'),
	withOp('op2'),
	withOp('OP 1'),
	withOp('op_3'),
]
const segments1a2 = tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr1a, opts1a, trips1a)
a.deepStrictEqual(segments1a2, [{
	lineNameOrFahrtNr: lineNameOrFahrtNr1a,
	opts: {...opts1a, operatorNames: ['OP 1']},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr1a,
	opts: {...opts1a, operatorNames: ['op2']},
}, {
	lineNameOrFahrtNr: lineNameOrFahrtNr1a,
	opts: {...opts1a, operatorNames: ['op_3']},
}])

const lineNameOrFahrtNr1a2a = segments1a2[0].lineNameOrFahrtNr
const opts1a2a = segments1a2[0].opts
a.throws(() => tripsListSegmentsFilters(mockHafas, lineNameOrFahrtNr1a2a, opts1a2a, []))

console.info('tripsListSegmentsFilters seems to be working ✔︎')
