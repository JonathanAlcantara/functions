const crypto = require('crypto');

const Router = require('express').Router;
const bodyParser = require('body-parser');
const Validator = require('jsonschema').Validator;

const log = require('../../support/log');
const schemas = require('../../domain/schemas');
const FunctionsRequest = require('../FunctionsRequest');
const SchemaResponse = require('../SchemaResponse');

const router = new Router();


function codeFileName(namespace, codeId) {
  return `${namespace}/${codeId}.js`;
}


function prefix(namespace, codeId) {
  return `namespace:${namespace}, id:${codeId}`;
}

router.get('/', (req, res) => {
  const memoryStorage = req.app.get('memoryStorage');
  const page = parseInt(req.query.page || '1', 10);
  const perPage = parseInt(req.query.perPage || '10', 10);

  memoryStorage.listNamespaces(page, perPage).then((list) => {
    const functionsRequest = new FunctionsRequest(req);

    new SchemaResponse(functionsRequest, res, 'functions/list')
      .json(list);
  }, (err) => {
    log.error(`Error listing namespaces and its functions: ${err}`);
    res.status(500).json({ error: err.message });
  });
});


router.post('/:namespace/:id', bodyParser.json(), (req, res) => {
  const validationResult = new Validator().validate(req.body, schemas['functions/item']);
  const memoryStorage = req.app.get('memoryStorage');

  if (!validationResult.valid) {
    const error = 'Invalid instance';
    const details = validationResult.errors.map(e => e.toString());

    res.status(400).json({ error, details });
    return;
  }

  const namespace = req.params.namespace;
  const id = req.params.id;
  const code = req.body.code;
  const sandbox = req.app.get('sandbox');
  const filename = codeFileName(namespace, id);
  const invalid = sandbox.testSyntaxError(filename, code, { prefix: prefix(namespace, id) });

  if (invalid) {
    log.error(`[${prefix(namespace, id)}] Failed to post code: ${invalid.error}`);
    res.status(400).json(invalid);
    return;
  }

  const hash = crypto.createHash('sha1').update(code).digest('hex');
  const data = { id, code, hash };

  memoryStorage.postCode(namespace, id, data).then((result) => {
    const codeResult = result[0][1];
    const hashResult = result[1][1];

    // When code and hash are already saved
    // we respond with a 400 - Bad Request
    if (codeResult === 0 || hashResult === 0) {
      res.status(400).json({ error: `The key ${namespace}:${id} already exists` });
      return;
    }

    res.set({ ETag: data.hash });

    const functionsRequest = new FunctionsRequest(req);

    new SchemaResponse(functionsRequest, res, 'functions/item').json(data);
  }, (err) => {
    log.error(`[${namespace}:${id}] ${err}`);
    res.status(500).json({ error: err.message });
  });
});


router.put('/:namespace/:id', bodyParser.json(), (req, res) => {
  const validationResult = new Validator().validate(req.body, schemas['functions/item']);
  const memoryStorage = req.app.get('memoryStorage');

  if (!validationResult.valid) {
    const error = 'Invalid instance';
    const details = validationResult.errors.map(e => e.toString());

    res.status(400).json({ error, details });
    return;
  }

  const namespace = req.params.namespace;
  const id = req.params.id;
  const code = req.body.code;
  const filename = codeFileName(namespace, id);
  const sandbox = req.app.get('sandbox');

  const invalid = sandbox.testSyntaxError(filename, code, { prefix: prefix(namespace, id) });
  if (invalid) {
    log.error(`[${prefix(namespace, id)}] Failed to post code: ${invalid.error}`);
    res.status(400).json(invalid);
    return;
  }

  const hash = crypto.createHash('sha1').update(code).digest('hex');
  const data = { id, code, hash };

  memoryStorage.putCode(namespace, id, data).then(() => {
    res.set({ ETag: data.hash });

    const functionsRequest = new FunctionsRequest(req);

    new SchemaResponse(functionsRequest, res, 'functions/item').json(data);
  }, (err) => {
    log.error(`[${namespace}:${id}] ${err}`);
    res.status(500).json({ error: err.message });
  });
});


router.get('/:namespace/:id', (req, res) => {
  const namespace = req.params.namespace;
  const id = req.params.id;
  const memoryStorage = req.app.get('memoryStorage');

  memoryStorage.getCode(namespace, id).then((code) => {
    if (!code) {
      const error = 'Code not found';
      log.error(`[${prefix(namespace, id)}] Code not found`);
      res.status(404).json({ error });
      return;
    }

    res.set({ ETag: code.hash });

    const functionsRequest = new FunctionsRequest(req);

    new SchemaResponse(functionsRequest, res, 'functions/item').json(code);
  }, (err) => {
    log.error(`[${prefix(namespace, id)}] ${err}`);
    res.status(500).json({ error: err.message });
  });
});


router.delete('/:namespace/:id', (req, res) => {
  const namespace = req.params.namespace;
  const id = req.params.id;
  const memoryStorage = req.app.get('memoryStorage');

  memoryStorage.deleteCode(namespace, id).then(() => {
    res.status(204).end();
  }, (err) => {
    log.error(`[${prefix(namespace, id)}] Failed to delete code id`);
    log.error(`[${prefix(namespace, id)}] ${err}`);
    res.status(500).json({ error: err.message });
  });
});


router.put('/:namespace/:id/run', bodyParser.json(), (req, res) => {
  const namespace = req.params.namespace;
  const id = req.params.id;
  const memoryStorage = req.app.get('memoryStorage');
  const sandbox = req.app.get('sandbox');
  const filename = codeFileName(namespace, id);

  memoryStorage
    .getCodeByCache(namespace, id, {
      preCache: (code) => {
        code.script = sandbox.compileCode(filename, code.code);
        return code;
      },
    })
    .then((code) => {
      if (!code) {
        const error = `Code '${namespace}/${id}' is not found`;
        log.error(`[${prefix(namespace, id)}] Code is not found`);
        res.status(404).json({ error });
        return null;
      }
      return sandbox.runScript(code.script, req, { prefix: prefix(namespace, id) });
    })
    .then((result) => {
      res.set(result.headers);
      res.status(result.status);
      res.send(result.body);
    }, (err) => {
      log.error(`[${prefix(namespace, id)}] Failed to run function: ${err}`);
      const status = err.statusCode || 500;
      res.status(status).json({ error: err.message });
    });
});


module.exports = router;
