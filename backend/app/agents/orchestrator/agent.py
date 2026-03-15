"""
Root orchestrator agent for Monet.

Uses Gemini for bidirectional voice interaction.
Delegates code generation to tool functions.
"""

from pathlib import Path

from google.adk.agents import Agent
from google.adk.tools import FunctionTool
from google.adk.tools._function_tool_declarations import (
    build_function_declaration_with_json_schema,
)
from google.genai import types

from ...config import ORCHESTRATOR_MODEL
from ..code import generate_code
from ..image.tool import generate_image

ORCHESTRATOR_INSTRUCTION = (
    Path(__file__).parent / "prompts.md"
).read_text(encoding="utf-8")


class JsonSchemaFunctionTool(FunctionTool):
    """FunctionTool variant that uses Pydantic JSON schema declarations."""

    def _get_declaration(self) -> types.FunctionDeclaration | None:
        return build_function_declaration_with_json_schema(
            self.func,
            ignore_params=self._ignore_params,
        )

agent = Agent(
    name="monet_orchestrator",
    model=ORCHESTRATOR_MODEL,
    instruction=ORCHESTRATOR_INSTRUCTION,
    tools=[
        JsonSchemaFunctionTool(func=generate_code),
        JsonSchemaFunctionTool(func=generate_image),
    ],
)
