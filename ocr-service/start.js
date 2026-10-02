/**
 * OCR 侧车服务启动器（跨平台）。
 * 首次运行自动创建 venv 并安装依赖；之后直接启动 uvicorn 服务（端口 1225）。
 * 用法：node ocr-service/start.js 或 pnpm run ocr
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const venvPython = path.join(dir, '.venv', win ? 'Scripts\\python.exe' : 'bin/python');

// venv 不存在则创建并安装依赖
if (!existsSync(venvPython)) {
  const py = win ? 'python' : 'python3';
  spawnSync(py, ['-m', 'venv', path.join(dir, '.venv')], { stdio: 'inherit' });
  spawnSync(venvPython, ['-m', 'pip', 'install', '-r', path.join(dir, 'requirements.txt'), '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple/'], { stdio: 'inherit' });
}

// 启动 uvicorn（模型常驻内存，端口 1225）
const child = spawn(
  venvPython,
  ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '1225', '--app-dir', dir],
  { stdio: 'inherit', cwd: dir },
);
child.on('exit', (code) => process.exit(code ?? 0));
