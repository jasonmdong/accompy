import os
import uvicorn


def main():
    host = os.getenv("ACCOMPY_HOST", "127.0.0.1")
    port = int(os.getenv("ACCOMPY_PORT", "8765"))
    uvicorn.run("src.server:app", host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
