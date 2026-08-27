"""Phase 1: confirm RocketRide Vector ingest + search actually works.

Starts the ingest pipeline, uploads one placeholder "tariff clause" PDF
through it (real DISCOM tariff order PDFs come later - none are available
yet), starts the query pipeline, asks a matching question, and checks
whether the placeholder clause comes back. This is a feasibility smoke
test, not the real Feature 6 tariff corpus load.

KNOWN ISSUE (as of 2026-08-27, staging.rocketride.ai): both a plain-text
payload and a hand-crafted minimal PDF fail identically at ingestion with
a UTF-8 decode error inside the webhook/parse layer - the failing byte
position/value tracks the exact content sent (confirmed via
get_task_status: totalSize/failedSize match the uploaded file exactly),
so this is not SDK version drift (reproduced on both the PyPI client and
the server-matched 1.3.0 wheel) or transport corruption. Retry this once
a real, application-generated tariff order PDF is available, and/or file
it with RocketRide support (#support on Discord) if it persists.

Usage: set SMOKETEST_PDF_PATH to a real PDF's path before running.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from rocketride import RocketRideClient
from rocketride.schema import Question
from rr_common import build_vector_ingest_pipeline, build_vector_query_pipeline


async def main():
    client = RocketRideClient()
    await client.connect()
    try:
        ingest = build_vector_ingest_pipeline()
        query = build_vector_query_pipeline()

        ingest_result = await client.use(pipeline=ingest, source="webhook_1", ttl=300, name="vector-smoketest-ingest")
        ingest_token = ingest_result["token"]
        print("ingest pipeline started:", ingest_token)

        pdf_path = os.environ["SMOKETEST_PDF_PATH"]
        results = await client.send_files([pdf_path], ingest_token)
        print("send_files() result:", results)

        query_result = await client.use(pipeline=query, source="chat_1", ttl=300, name="vector-smoketest-query")
        query_token = query_result["token"]
        print("query pipeline started:", query_token)

        question = Question()
        question.addQuestion("What multiplier applies to excess Maximum Demand?")
        response = await client.chat(token=query_token, question=question)
        print("chat() response:", response)

        await client.terminate(ingest_token)
        await client.terminate(query_token)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
