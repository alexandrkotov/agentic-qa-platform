Feature: security

  @security @security
  Scenario: SQL Injection in customer email
    When I send a POST request to create a customer with email "'; DROP TABLE Customer; --" and name "SQL Injection Test"
    Then the customer creation response should indicate success or validation error
    And the Customer table should still exist in the database
    And no SQL injection should have affected the database integrity

  @security @security
  Scenario: XSS in product name
    When I send a POST request to create a product named "<script>alert('XSS')</script>" with price 19.99
    Then the product creation response should indicate success
    When I navigate to the products page
    Then the product name should be properly escaped in the UI and not execute script
