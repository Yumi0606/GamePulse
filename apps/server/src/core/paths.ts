/**
 * 仓库路径锚点：从模块文件位置回溯，不依赖进程工作目录。
 *
 * 背景：pnpm workspace 下脚本可能以 apps/server 为工作目录启动，若用 path.resolve('data')
 * 会解析到 apps/server/data。src 与 dist 的目录深度一致（apps/server/{src,dist}/core/），
 * 故同一相对深度对两种运行方式都成立。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（含 package.json、data/、logs/） */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** SQLite 数据目录 */
export const DATA_DIR = path.join(REPO_ROOT, 'data');

/** 默认日志文件路径；LOG_FILE 环境变量可覆盖 */
export const DEFAULT_LOG_FILE = path.join(REPO_ROOT, 'logs', 'app.log');
