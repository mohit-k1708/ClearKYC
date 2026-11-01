const service = require('../services/personService');
const { parseId } = require('../services/requirementService');

// GET /api/beneficial-owners/:id/person  (the person behind one owner record)
async function getPersonOfOwner(req, res) {
  res.json({ data: await service.getPerson(await service.personRefOfOwner(parseId(req.params.id))) });
}

// GET /api/people/:personRef
async function getPerson(req, res) {
  res.json({ data: await service.getPerson(req.params.personRef) });
}

module.exports = { getPersonOfOwner, getPerson };
