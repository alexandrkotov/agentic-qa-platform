Feature: security

  @security @security
  Scenario: Login with invalid credentials
    Given I am on the Uptime Kuma login page for security testing
    When I enter username "admin" for login attempt
    And I enter an incorrect password "wrongpassword123"
    And I click the login button
    Then the login should fail with an error message
    And no session should be created

  @security @security
  Scenario: Access dashboard without authentication
    Given I have no active session
    When I attempt to navigate directly to the dashboard page
    Then I should be redirected to the login page
    And the dashboard content should not be accessible

  @security @security
  Scenario: Two-factor authentication setup
    Given I am authenticated as admin for 2FA setup
    When I navigate to the security settings for 2FA
    And I initiate 2FA setup
    Then the 2FA secret should be generated
    And the twofa_status should be updated in the database

  @happy_path @security
  Scenario: Login with valid credentials
    Given I am on the Uptime Kuma login page for valid login test
    When I enter the admin username "admin"
    And I enter the correct admin password
    And I submit the login form
    Then I should be redirected to the dashboard successfully
    And my session should be active

  @happy_path @security
  Scenario: Create API key and test authentication
    Given I am authenticated as admin for API key creation
    When I navigate to the API keys settings
    And I create a new API key with name "Test API Key"
    Then the API key should appear in the api_key table
    And the API key should be marked as active
