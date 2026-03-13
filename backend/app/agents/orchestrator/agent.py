"""
Root orchestrator agent for Monet.

Uses Gemini for bidirectional voice interaction.
Delegates code generation to tool functions.
"""

from pathlib import Path

from google.adk.agents import Agent
from google.adk.tools import FunctionTool

from ...config import ORCHESTRATOR_MODEL
from ..code import generate_code
from ..image.tool import generate_image

ORCHESTRATOR_INSTRUCTION = (
    Path(__file__).parent / "prompts.md"
).read_text(encoding="utf-8")

agent = Agent(
    name="monet_orchestrator",
    model=ORCHESTRATOR_MODEL,
    instruction=ORCHESTRATOR_INSTRUCTION,
    tools=[
        FunctionTool(func=generate_code),
        FunctionTool(func=generate_image),
    ],
)
