from app.models.oci import EnterpriseAISettings
from app.services.oci_service import OCIService


def test_enterprise_ai_settings_round_trip(tmp_path):
    service = OCIService()
    service.env_file = tmp_path / ".env"
    settings = EnterpriseAISettings(
        base_url="https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1/",
        project=None,
        api_key="secret",
        model="openai.gpt-oss-120b",
    )

    service.save_enterprise_ai_settings(settings)

    assert service.get_enterprise_ai_settings() == settings.model_copy(
        update={"base_url": settings.base_url.rstrip("/")}
    )
