global with sharing class TransformIncomeRecords implements Callable {
    
    /*
    * @description      : Inserts the MemberRemoved flag in income details object for removed household members
    * @return output    : Object containing updated member income details
    */
    global Object call(String action, Map<String, Object> args) {
        Map<String, Object> input = (Map<String, Object>)args.get('input');
        Map<String, Object> output = (Map<String, Object>)args.get('output');
        
        Object incomeDetailsObj = input.get('PSS_BM_v3_HouseholdIncomeDetails');
        // Null check for Household Income
        if(incomeDetailsObj == null || incomeDetailsObj instanceof String) {
            return output.put('PSS_BM_v3_HouseholdIncomeDetails', incomeDetailsObj);
        }
        
        List<Object> incomedetails = new List<Object>();
        
        if(String.valueOf(incomeDetailsObj).substring(0, 1).equals('{')) {
            incomedetails.add(incomeDetailsObj);
        } else {
            incomeDetails = (List<Object>)(input.get('PSS_BM_v3_HouseholdIncomeDetails'));
        }
        
        Object memberListObj = input.get('MemberList');
        // Null check for Household Member List
        if(memberListObj == null || memberListObj instanceof String) {
            return output.put('PSS_BM_v3_HouseholdIncomeDetails', incomedetails);
        }
        
        List<Object> memberList = new List<Object>();
        
        if(String.valueOf(memberListObj).substring(0, 1).equals('{')) {
            memberList.add(memberListObj);
        } else {
            memberList = (List<Object>)(input.get('MemberList'));
        }
            
        List<Object> result = new List<Object>();
        
        // To store name list of removed household members 
        Set<String> removedMembers = new Set<String>();
        
        // Removed household members have AQ 'PSS_BM_v3_MemberSectionAction' set to Remove member, 
        // add those member names to removed member list
        for(Object member : memberList) {
            Map<String,Object> memberDetails = (Map<String, Object>) member;
            if(memberDetails.containsKey('PSS_BM_v3_MemberSectionAction') && memberDetails.get('PSS_BM_v3_MemberSectionAction').equals('Remove member')) {
                removedMembers.add((String) memberDetails.get('PSS_BM_v3_HouseholdMemberName'));
            }
        }
        
        // Insert removed income flag to income details of removed members
        for(Object income : incomedetails) {
            insertIncomeRemovedFlag(result, income, removedMembers);
        }                
        
        return output.put('PSS_BM_v3_HouseholdIncomeDetails', result);
    }

    /*
    * @description          : Inserts the MemberRemoved flag in income details object for removed household members
    * @param result         : Updated Income Details List
    * @param income         : Income detail object
    * @param removedMembers : List of names of removed members
    * @return void
    */
    global void insertIncomeRemovedFlag(List<Object> result, Object income, Set<String> removedMembers) {
        Map<String,Object> incomeDetails = (Map<String, Object>)income;
        String name = (String) incomeDetails.get('PSS_BM_v3_ExistingIncomeHouseholdMemberName');
        if(removedMembers.contains(name)) {
            // Insert MemberRemoved flag
            incomeDetails.put('MemberRemoved', 'Yes');
        }
        result.add(incomeDetails);
    }
      
}