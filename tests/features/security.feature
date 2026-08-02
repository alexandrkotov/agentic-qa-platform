Feature: security

  @security @security
  Scenario: SQL Injection in customer email
    Given I attempt to create a customer with SQL injection in the email field
    When I submit the customer creation request
    Then the customer creation should not execute arbitrary SQL
    And the request should either fail validation or create a customer with the literal injection string

  @security @security
  Scenario: XSS in product name
    Given I create a product with XSS payload in the name field
    When I view the products page in the browser
    Then the XSS payload should be escaped and displayed as text
    And no script should execute on the page
