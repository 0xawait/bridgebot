import winston from 'winston';
import 'winston-daily-rotate-file';
import { LOG_CONFIG } from '../config/index.js';

/** 日志文件传输：单文件按天滚动，自动压缩归档，保留 14 天（error 级别同样写入该文件） */
const dailyRotateFileTransport: winston.transport = new winston.transports.DailyRotateFile({
    filename: LOG_CONFIG.filename,
    datePattern: LOG_CONFIG.datePattern,
    zippedArchive: LOG_CONFIG.zippedArchive,
    maxSize: LOG_CONFIG.maxSize,
    maxFiles: LOG_CONFIG.maxFiles,
    level: LOG_CONFIG.level
});

/** 全局日志实例，同时输出到控制台与滚动日志文件 */
const logger: winston.Logger = winston.createLogger({
    level: LOG_CONFIG.level,
    format: winston.format.combine(
        winston.format.timestamp({ format: LOG_CONFIG.timestampFormat }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        dailyRotateFileTransport
    ],
});

export default logger;
