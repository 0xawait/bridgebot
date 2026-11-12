import mysql, {
    type Pool,
    type PoolConnection,
    type ResultSetHeader,
    type RowDataPacket,
} from 'mysql2/promise';
import { DB_CONFIG } from '../config/index.js';

/** 查询结果类型，与 mysql2 query 泛型约束保持一致 */
type QueryResult = RowDataPacket[] | RowDataPacket[][] | ResultSetHeader | ResultSetHeader[];

/** 数据库连接池单例，延迟初始化；初始化失败时置空以便下次重试 */
let poolPromise: Promise<Pool> | null = null;

/**
 * 构造数据库连接池配置
 * 连接参数统一由 src/config 提供，未配置的项交由 mysql2 使用默认值
 * @returns mysql2 连接池配置
 */
function buildPoolOptions(): mysql.PoolOptions {
    const options: mysql.PoolOptions = {
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 30,
        queueLimit: 100,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
    };

    if (DB_CONFIG.host) options.host = DB_CONFIG.host;
    if (DB_CONFIG.port) options.port = DB_CONFIG.port;
    if (DB_CONFIG.user) options.user = DB_CONFIG.user;
    if (DB_CONFIG.password) options.password = DB_CONFIG.password;
    if (DB_CONFIG.database) options.database = DB_CONFIG.database;

    return options;
}

/**
 * 获取数据库连接池
 * @returns 已初始化的数据库连接池
 */
export async function getPool(): Promise<Pool> {
    if (!poolPromise) {
        poolPromise = (async (): Promise<Pool> => {
            try {
                const pool: Pool = mysql.createPool(buildPoolOptions());

                const conn: PoolConnection = await pool.getConnection();
                conn.release();
                console.log('数据库连接池初始化成功');
                return pool;
            } catch (err) {
                poolPromise = null;
                console.error('数据库连接池初始化失败:', err instanceof Error ? err.stack : err);
                throw err;
            }
        })();
    }
    return poolPromise;
}

/**
 * 执行单次 SQL 查询
 * @param query sql 语句
 * @param values 参数数组
 * @returns 查询结果，可按需指定结果类型
 */
async function dbQuery<T extends QueryResult = RowDataPacket[]>(
    query: string,
    values: unknown[] = []
): Promise<T> {
    const currentPool = await getPool();
    try {
        const [rows] = await currentPool.query<T>(query, values);
        return rows;
    } catch (err) {
        console.error('SQL查询错误:', err instanceof Error ? err.stack : err);
        throw err;
    }
}

/**
 * 事务执行
 * @param callback 事务逻辑回调函数，接收事务连接
 * @returns 回调函数的执行结果
 */
export async function withTransaction<T>(
    callback: (conn: PoolConnection) => Promise<T>
): Promise<T> {
    const currentPool = await getPool();
    const conn: PoolConnection = await currentPool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await callback(conn);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * 关闭数据库连接池
 * @returns 关闭完成后的 Promise
 */
export async function closePool(): Promise<void> {
    if (poolPromise) {
        const currentPool = await poolPromise;
        await currentPool.end();
        poolPromise = null;
        console.log('数据库连接池已安全关闭');
    }
}

export default dbQuery;