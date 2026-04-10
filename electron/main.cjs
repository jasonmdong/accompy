const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = Number(process.env.ACCOMPY_PORT || 8765);
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const ROOT_DIR = path.resolve(__dirname, '..');
const DEV_SCORES_DIR = path.join(ROOT_DIR, 'scores');
const DEV_STATIC_DIR = path.join(ROOT_DIR, 'static');

let mainWindow = null;
let serverProcess = null;
let isQuitting = false;

function bundledResourcesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app-resources')
    : ROOT_DIR;
}

function bundledScoresDir() {
  return app.isPackaged
    ? path.join(bundledResourcesDir(), 'starter-scores')
    : DEV_SCORES_DIR;
}

function bundledStaticDir() {
  return app.isPackaged
    ? path.join(bundledResourcesDir(), 'static')
    : DEV_STATIC_DIR;
}

function resolvePythonExecutable() {
  const candidates = [];
  const venvDir = path.join(ROOT_DIR, '.venv', 'bin');
  candidates.push(path.join(venvDir, 'python3'));
  candidates.push(path.join(venvDir, 'python'));
  if (process.env.PYTHON_PATH) candidates.push(process.env.PYTHON_PATH);
  candidates.push('python3');
  candidates.push('python');

  return candidates.find((candidate) => {
    if (!candidate) return false;
    return candidate === 'python3' || candidate === 'python' || fs.existsSync(candidate);
  });
}

function resolveBackendCommand() {
  if (app.isPackaged) {
    const binaryName = process.platform === 'win32' ? 'accompy-backend.exe' : 'accompy-backend';
    const packagedBinary = path.join(bundledResourcesDir(), 'backend', binaryName);
    if (fs.existsSync(packagedBinary)) {
      return { cmd: packagedBinary, args: [] };
    }
  }

  const python = resolvePythonExecutable();
  if (!python) return null;
  return {
    cmd: python,
    args: ['-m', 'uvicorn', 'src.server:app', '--host', SERVER_HOST, '--port', String(SERVER_PORT)],
  };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const backend = resolveBackendCommand();
    if (!backend) {
      reject(new Error('No bundled backend or Python executable found.'));
      return;
    }

    const userScoresDir = path.join(app.getPath('userData'), 'scores');
    seedScoresIfNeeded(userScoresDir);
    const env = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      ACCOMPY_HOST: SERVER_HOST,
      ACCOMPY_PORT: String(SERVER_PORT),
      ACCOMPY_SCORES_DIR: userScoresDir,
      ACCOMPY_STATIC_DIR: bundledStaticDir(),
    };

    serverProcess = spawn(backend.cmd, backend.args, {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (chunk) => {
      process.stdout.write(`[accompy-server] ${chunk}`);
    });
    serverProcess.stderr.on('data', (chunk) => {
      process.stderr.write(`[accompy-server] ${chunk}`);
    });

    serverProcess.once('error', (error) => {
      reject(error);
    });

    serverProcess.once('exit', (code) => {
      if (!isQuitting && code !== 0) {
        dialog.showErrorBox(
          'accompy backend stopped',
          `The local Python server exited with code ${code}. Check the terminal logs for details.`
        );
      }
    });

    waitForServer()
      .then(resolve)
      .catch((error) => reject(error));
  });
}

function seedScoresIfNeeded(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const existing = fs.readdirSync(targetDir).filter((name) => name.endsWith('.py'));
  const sourceDir = bundledScoresDir();
  if (existing.length || !fs.existsSync(sourceDir)) return;

  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.py') && !file.endsWith('.html')) continue;
    fs.copyFileSync(
      path.join(sourceDir, file),
      path.join(targetDir, file)
    );
  }
}

function waitForServer(timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const req = http.get(`${SERVER_URL}/api/scores`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      req.on('error', retry);
      req.setTimeout(1200, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for the accompy backend to start.'));
        return;
      }
      setTimeout(tryConnect, 300);
    };

    tryConnect();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1100,
    minHeight: 760,
    backgroundColor: '#0f0f13',
    title: 'accompy',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(SERVER_URL);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function stopBackend() {
  if (!serverProcess) return;
  try {
    serverProcess.kill('SIGTERM');
  } catch {}
  serverProcess = null;
}

app.whenReady().then(async () => {
  try {
    await startBackend();
    createWindow();
  } catch (error) {
    const setupHelp = app.isPackaged
      ? `Backend startup failed.\n\nIf this is a packaged beta, rebuild the app bundle so it includes the backend binary.`
      : `Run:\n  ./scripts/setup_desktop_mac.sh\n  ./scripts/run_desktop_mac.sh\n\nIf Python is installed elsewhere, set PYTHON_PATH before launching.`;
    dialog.showErrorBox(
      'accompy failed to start',
      `${error.message}\n\n${setupHelp}`
    );
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
