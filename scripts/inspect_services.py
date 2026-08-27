"""One-off: dump full service definitions for the components Phase 1 needs.

The static .rocketride/schema/*.json files in this workspace are metadata-only
stubs (no Pipe.schema config section), so we ask the connected dev server for
the full definitions instead, per ROCKETRIDE_python_API.md #3 get_service().
"""
import asyncio
import json

from rocketride import RocketRideClient


async def main():
    client = RocketRideClient()  # reads ROCKETRIDE_URI / ROCKETRIDE_APIKEY from .env
    await client.connect()
    try:
        print("connected:", client.get_connection_info())
        services = await client.get_services()
        names = sorted(services.get("services", {}).keys())
        for want in ["tools", "rocketride_sql", "rocketride_vector", "llm_gemini", "embedding_transformer"]:
            print(f"\n--- present in get_services()? {want}: {want in names} ---")

        for name in ["tools", "rocketride_sql", "llm_gemini"]:
            print(f"\n===== get_service('{name}') =====")
            svc = await client.get_service(name)
            print(json.dumps(svc, indent=2, default=str)[:6000])
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
