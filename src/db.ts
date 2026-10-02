import { MongoClient, Db, Collection, ClientSession } from "mongodb";
import { config } from "./config";
import { type qbo_object_map } from "./qbo/object_map";
import { type subc_doc, type hresource_doc } from "./vendors/subc";

let client: MongoClient;
let db: Db;

async function connect(): Promise<void> {
    client = new MongoClient(config.mongo_uri, { appName: `qbosync-${config.qbo_env}` });
    await client.connect();
    db = client.db(config.mongo_db_name);
    ilog(`[startup] Connected to MongoDB: ${config.mongo_db_name}`);
}

async function disconnect(): Promise<void> {
    await client.close();
}

// Runs fn inside a multi-document transaction. withTransaction may re-invoke fn on
// transient errors, so fn must be safe to retry. Requires a replica set / mongos.
async function with_transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return client.withSession((session) => session.withTransaction((s) => fn(s)));
}

function get_db(): Db {
    return db;
}

function get_qbo_map_objects(): Collection<qbo_object_map> {
    return db.collection<qbo_object_map>("qbo_object_map");
}

function get_subcs(): Collection<subc_doc> {
    return db.collection<subc_doc>("subcontractor");
}

function get_hresources(): Collection<hresource_doc> {
    return db.collection<hresource_doc>("hresource");
}

// Unique per side so a subc can never be linked to two vendors (or a vendor to two
// subcs), even if bootstrap and the sync race or a bug double-inserts.
async function ensure_indexes(): Promise<void> {
    const map_col = get_qbo_map_objects();
    await map_col.createIndex({ type: 1, qbo_id: 1 }, { unique: true });
    await map_col.createIndex({ type: 1, our_id: 1 }, { unique: true });
}

const mongo = {
    connect,
    disconnect,
    with_transaction,
    ensure_indexes,
    get_db,
    get_qbo_map_objects,
    get_subcs,
    get_hresources,
};

export default mongo;
