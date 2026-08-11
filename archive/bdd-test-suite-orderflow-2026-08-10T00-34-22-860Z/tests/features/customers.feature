Feature: customers

  @happy_path @customers
  Scenario: Create Customer with valid data
    Given I am on the customers page
    When I fill in the customer email field with a unique email
    And I fill in the customer name field with "Test Customer"
    And I click the Add Customer button
    Then the new customer should appear in the customers table
    And the customer should exist in the Customer database table

  @edge_case @customers
  Scenario: Create Customer with missing email
    Given I am on the customers page
    When I leave the customer email field empty
    And I fill in the customer name field with "No Email Customer"
    And I click the Add Customer button
    Then the customer creation should fail with a validation error

  @edge_case @customers
  Scenario: Create Customer with missing name
    Given I am on the customers page
    When I fill in the customer email field with a unique email
    And I leave the customer name field empty
    And I click the Add Customer button
    Then the customer creation should fail with a validation error

  @edge_case @customers
  Scenario: Create Customer with duplicate email
    Given a customer already exists with a known email
    And I am on the customers page
    When I fill in the customer email field with the existing customer email
    And I fill in the customer name field with "Duplicate Email Customer"
    And I click the Add Customer button
    Then the duplicate customer creation should be rejected

  @happy_path @customers
  Scenario: Update customer information
    Given a customer exists with email "update-test@example.com" and name "Original Name"
    When I update the customer name to "Updated Name"
    Then the customer update response should indicate success
    And the customer in the database should have name "Updated Name"

  @happy_path @customers
  Scenario: Delete customer with no orders
    Given a customer exists with email "delete-no-orders@example.com" and name "No Orders Customer"
    And the customer has no orders
    When I delete the customer
    Then the customer deletion response should indicate success
    And the customer should no longer exist in the database

  @edge_case @customers
  Scenario: Delete customer with existing orders
    Given a customer exists with email "delete-with-orders@example.com" and name "Has Orders Customer"
    And a product exists with name "Order Product" and price 25.00
    And an order exists for that customer with that product
    When I attempt to delete the customer with orders
    Then the customer deletion response should be a 409 conflict
    And the error message should indicate the customer has orders
    And the customer should still exist in the database
