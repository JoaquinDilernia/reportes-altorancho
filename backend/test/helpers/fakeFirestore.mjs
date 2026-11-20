// Firestore en memoria para tests. Las transacciones se serializan.
const clone = (v) => structuredClone(v);
const val = (x) => (x instanceof Date ? x.getTime() : x);

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function createFakeFirestore() {
  const cols = new Map();
  let autoId = 0;
  let chain = Promise.resolve();
  const colMap = (name) => { if (!cols.has(name)) cols.set(name, new Map()); return cols.get(name); };

  function docRef(name, id) {
    return {
      id,
      async get() {
        const d = colMap(name).get(id);
        return { exists: d !== undefined, id, data: () => (d === undefined ? undefined : clone(d)) };
      },
      async set(data, opts) {
        const cur = colMap(name).get(id);
        colMap(name).set(id, opts?.merge && cur ? { ...cur, ...clone(data) } : clone(data));
      },
      async update(patch) {
        const cur = colMap(name).get(id);
        if (cur === undefined) throw new Error(`NOT_FOUND: ${name}/${id}`);
        colMap(name).set(id, { ...cur, ...clone(patch) });
      },
    };
  }

  function query(name, filters = [], order = null, lim = null) {
    const run = async () => {
      let rows = [...colMap(name).entries()].map(([id, d]) => ({ id, d }));
      for (const { f, op, v } of filters) {
        rows = rows.filter(({ d }) => {
          const x = val(getPath(d, f));
          if (op === '==') return x === val(v);
          if (op === 'in') return v.map(val).includes(x);
          throw new Error(`op no soportado: ${op}`);
        });
      }
      if (order) {
        rows.sort((a, b) => {
          const x = val(getPath(a.d, order.f)); const y = val(getPath(b.d, order.f));
          const c = x < y ? -1 : x > y ? 1 : 0;
          return order.dir === 'desc' ? -c : c;
        });
      }
      if (lim != null) rows = rows.slice(0, lim);
      return rows;
    };
    return {
      where: (f, op, v) => query(name, [...filters, { f, op, v }], order, lim),
      orderBy: (f, dir = 'asc') => query(name, filters, { f, dir }, lim),
      limit: (n) => query(name, filters, order, n),
      async get() {
        const rows = await run();
        const docs = rows.map(({ id, d }) => ({ exists: true, id, data: () => clone(d) }));
        return { docs, size: docs.length, empty: !docs.length };
      },
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
    };
  }

  return {
    collection(name) {
      return { ...query(name), doc: (id) => docRef(name, id ?? `auto${++autoId}`) };
    },
    runTransaction(fn) {
      const run = chain.then(() => fn({
        get: (ref) => ref.get(),
        set: (ref, data, opts) => ref.set(data, opts),
        update: (ref, patch) => ref.update(patch),
      }));
      chain = run.catch(() => {});
      return run;
    },
  };
}
