

- In the publish history, allow users to leave comments on each version, not just star


- Убедиться, что RIVET_RECORDINGS_MAX_PENDING_WRITES работает правильно — на каждую реплику






- Как-то помнить используемые библиотеки чтобы предупреждать что в лайве форкфлоу с такой-то библиотекой а ты собираешься удалить ее?

- Сделать внешний вызов, чтобы через него легко запускать другие воркфлоу внутри сети без конструирования боди и запары с портами и внутренними урлами? Наверное нет потому что параметры передавтаь так же заебно. Но зато не нужно указывать url и заголовков.

- Pass a webhook for a workflow right in the URL parameters like:
host/workflows/name?webhook1=https://example.com/api/v1/webhook1&webhook2=https://example.com/api/v1/webhook2
In this case we need a custom url parser so that we can extract the webhook parameters even though they are not traditional in terms of what  characters are used.

Each such webhook mmust be passed to the rivet workflow call as external functions.

host/workflows/name?webhook1=https://example.com/api/v1/webhook1&webhook2=https://example.com/api/v1/webhook2

const project = await loadProjectFromFile(workflowPath);
const result = await runGraph(project, {
  inputs: {
    input: {
      type: "any",
      value: {
        payload: req.body ?? {}
      }
    }
  },

  externalFunctions: {
    webhook1: async (...args): => {
      return {
        type: 'any',
        value: [code that will senbd a POST request to https://example.com/api/v1/webhook1 and pass args in a body and return its response here],
      };
    },
    webhook2: async (...args): => {
      return {
        type: 'any',
        value: [code that will senbd a POST request to https://example.com/api/v1/webhook2 and pass args in a body and return its response here],
      };
    }
  }

});


