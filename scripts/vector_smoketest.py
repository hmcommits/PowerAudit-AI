"""Phase 1: confirm RocketRide Vector ingest + search actually works.

Starts the ingest pipeline, sends one placeholder "tariff clause" sentence
through it (real DISCOM tariff order PDFs come later - none are available
yet), starts the query pipeline, asks a matching question, and confirms the
placeholder clause comes back. This is a feasibility smoke test, not the
real Feature 6 tariff corpus load.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from rocketride import RocketRideClient
from rocketride.schema import Question
from rr_common import build_vector_ingest_pipeline, build_vector_query_pipeline

PLACEHOLDER_CLAUSE = (
    "Clause 9.3 (placeholder test data, not a real tariff order): "
    "Maximum Demand penalty is charged at 1.75 times the demand charge rate "
    "for kVA recorded in excess of the Contract Demand."
)


async def main():
    client = RocketRideClient()
    await client.connect()
    try:
        ingest = build_vector_ingest_pipeline()
        query = build_vector_query_pipeline()

        ingest_result = await client.use(pipeline=ingest, source="webhook_1", ttl=300, name="vector-smoketest-ingest")
        ingest_token = ingest_result["token"]
        print("ingest pipeline started:", ingest_token)

        send_result = await client.send(
            ingest_token,
            PLACEHOLDER_CLAUSE,
            objinfo={"name": "placeholder-clause.txt"},
            mimetype="text/plain",
        )
        print("send() result:", send_result)

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
