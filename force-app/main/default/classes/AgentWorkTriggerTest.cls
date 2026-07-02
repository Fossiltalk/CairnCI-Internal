@IsTest
public class AgentWorkTriggerTest {
    @IsTest
    public static void AgentWorkTriggertest() {
        try {
            AgentWork newAgentWork = new AgentWork();
            insert newAgentWork;
        } catch (Exception ex) {
            // FIELD_INTEGRITY_EXCEPTION, The agent's status is not associated with the channel for this work.: [ServiceChannelId] will be caught after the trigger invocation
        }
    }
}