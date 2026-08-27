"""Shared helpers for the PowerAudit AI foundation setup/check scripts."""
import json
import os

FOUNDATION_PROJECT_ID = "b3f2a6b4-9b0d-4c3a-8e77-4a2f6a1c9d10"
FOUNDATION_SOURCE = "tools_1"
FOUNDATION_PIPE_PATH = os.path.join(os.path.dirname(__file__), "..", "pipelines", "foundation-sql.pipe")

VECTOR_COLLECTION = "tariff_orders"
VECTOR_INGEST_PROJECT_ID = "d1e9c2b7-6a4f-4e21-9c3a-7b5d2f8e1a44"
VECTOR_QUERY_PROJECT_ID = "f4a7d3c1-2b6e-4a95-8f1d-3c9b6e4a7f22"
VECTOR_INGEST_PIPE_PATH = os.path.join(os.path.dirname(__file__), "..", "pipelines", "tariff-vector-ingest.pipe")
VECTOR_QUERY_PIPE_PATH = os.path.join(os.path.dirname(__file__), "..", "pipelines", "tariff-vector-query.pipe")


def node(id_, provider, config, input_=None, control=None, ui=None):
    c = {"id": id_, "provider": provider, "config": config}
    if input_ is not None:
        c["input"] = input_
    if control is not None:
        c["control"] = control
    c["ui"] = ui or {
        "position": {"x": 20, "y": 200},
        "measured": {"width": 150, "height": 66},
        "nodeType": "default",
        "formDataValid": True,
    }
    return c


def build_foundation_sql_pipeline():
    tools_1 = node(
        "tools_1",
        "tools",
        {"hideForm": True, "mode": "Source", "parameters": {}, "type": "tools"},
        ui={"position": {"x": 20, "y": 200}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True},
    )
    rocketride_sql_1 = node(
        "rocketride_sql_1",
        "rocketride_sql",
        {
            "profile": "default",
            "default": {
                "db_description": (
                    "PowerAudit AI relational store: Site, Meter, TariffOrder, Bill, "
                    "Finding, Alert, Claim tables for auditing Indian commercial/industrial "
                    "electricity bills (MD/PF penalty recalculation, disputes, claims)."
                ),
                "table": "_direct_execute",
                "max_attempts": 5,
                "allow_execute": True,
            },
            "parameters": {},
        },
        control=[{"classType": "tool", "from": "tools_1"}],
        ui={"position": {"x": 240, "y": 200}, "measured": {"width": 150, "height": 135}, "nodeType": "default", "formDataValid": True},
    )
    llm_gemini_1 = node(
        "llm_gemini_1",
        "llm_gemini",
        {
            "profile": "gemini-2_5-flash-lite",
            "5-flash-lite": {"apikey": "${ROCKETRIDE_GEMINI_KEY}"},
            "parameters": {},
        },
        control=[{"classType": "llm", "from": "rocketride_sql_1"}],
        ui={"position": {"x": 240, "y": 360}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True},
    )
    return {
        "components": [tools_1, rocketride_sql_1, llm_gemini_1],
        "source": "tools_1",
        "project_id": FOUNDATION_PROJECT_ID,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "version": 1,
    }


def build_vector_ingest_pipeline():
    webhook_1 = node(
        "webhook_1",
        "webhook",
        {"hideForm": True, "mode": "Source", "parameters": {}, "type": "webhook"},
    )
    parse_1 = node("parse_1", "parse", {}, input_=[{"lane": "tags", "from": "webhook_1"}], ui={"position": {"x": 240, "y": 200}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True})
    preprocessor_1 = node(
        "preprocessor_langchain_1",
        "preprocessor_langchain",
        {"parameters": {}},
        input_=[{"lane": "text", "from": "parse_1"}],
        ui={"position": {"x": 460, "y": 200}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True},
    )
    embedding_1 = node(
        "embedding_transformer_1",
        "embedding_transformer",
        {"profile": "miniLM", "parameters": {}},
        input_=[{"lane": "documents", "from": "preprocessor_langchain_1"}],
        ui={"position": {"x": 680, "y": 200}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True},
    )
    vector_1 = node(
        "rocketride_vector_1",
        "rocketride_vector",
        {
            "profile": "cloud",
            "cloud": {
                "collection": VECTOR_COLLECTION,
                "score": 0.5,
                "similarity": "cosine",
                "hnsw_m": 16,
                "hnsw_ef_construction": 64,
            },
            "parameters": {},
        },
        input_=[{"lane": "documents", "from": "embedding_transformer_1"}],
        ui={"position": {"x": 900, "y": 200}, "measured": {"width": 150, "height": 135}, "nodeType": "default", "formDataValid": True},
    )
    return {
        "components": [webhook_1, parse_1, preprocessor_1, embedding_1, vector_1],
        "source": "webhook_1",
        "project_id": VECTOR_INGEST_PROJECT_ID,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "version": 1,
    }


def build_vector_query_pipeline():
    chat_1 = node(
        "chat_1",
        "chat",
        {"hideForm": True, "mode": "Source", "parameters": {}, "type": "chat"},
    )
    embedding_1 = node(
        "embedding_transformer_1",
        "embedding_transformer",
        {"profile": "miniLM", "parameters": {}},
        input_=[{"lane": "questions", "from": "chat_1"}],
        ui={"position": {"x": 240, "y": 200}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True},
    )
    vector_1 = node(
        "rocketride_vector_1",
        "rocketride_vector",
        {
            "profile": "cloud",
            "cloud": {
                "collection": VECTOR_COLLECTION,
                "score": 0.3,
                "similarity": "cosine",
                "hnsw_m": 16,
                "hnsw_ef_construction": 64,
            },
            "parameters": {},
        },
        input_=[{"lane": "questions", "from": "embedding_transformer_1"}],
        ui={"position": {"x": 460, "y": 200}, "measured": {"width": 150, "height": 135}, "nodeType": "default", "formDataValid": True},
    )
    response_1 = node(
        "response_documents_1",
        "response_documents",
        {"laneName": "documents"},
        input_=[{"lane": "documents", "from": "rocketride_vector_1"}],
        ui={"position": {"x": 680, "y": 200}, "measured": {"width": 150, "height": 66}, "nodeType": "default", "formDataValid": True},
    )
    return {
        "components": [chat_1, embedding_1, vector_1, response_1],
        "source": "chat_1",
        "project_id": VECTOR_QUERY_PROJECT_ID,
        "viewport": {"x": 0, "y": 0, "zoom": 1},
        "version": 1,
    }


def write_pipe(path, pipeline):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(pipeline, f, indent=2)
        f.write("\n")
