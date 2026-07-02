trigger ProcessIAForBenefitAssistance on IndividualApplication (after update) {
    String procedureNameForNewIA = 'BenefitManagement_ProcessIndividualApplication';
    String procedureNameForRecertification = 'BenefitManagement_ProcessIndividualApplicationForRecertification';
    Map <String, Object> ipInput = new Map <String, Object> ();
    Map <String, Object> ipOutput = new Map <String, Object> ();
    Map <String, Object> ipOptions = new Map <String, Object> ();
    
    for (IndividualApplication ia: trigger.new) {
       
        /* Populating input map for an Integration Procedure. Follow whatever structure your VIP expects */
        if(ia.Status == 'Submitted' && ia.Category == 'Benefit' && ia.ApplicationType != 'Recertification') {
            String recordId = ia.Id;
            ipInput.put('RecordId', recordId);
        
            /* Call the IP via runIntegrationService, and save the output to ipOutput */
            ipOutput = (Map <String, Object>) omnistudio.IntegrationProcedureService.runIntegrationService(procedureNameForNewIA, ipInput, ipOptions);
        
            System.debug('IP Output: ' + ipOutput);
        }
        if(ia.Status == 'Submitted' && ia.Category == 'Benefit' && ia.ApplicationType == 'Recertification') {
            String recordId = ia.Id;
            ipInput.put('RecordId', recordId);
        
            /* Call the IP via runIntegrationService, and save the output to ipOutput */
            ipOutput = (Map <String, Object>) omnistudio.IntegrationProcedureService.runIntegrationService(procedureNameForRecertification, ipInput, ipOptions);
        
            System.debug('IP Output: ' + ipOutput);
        }
    }
}