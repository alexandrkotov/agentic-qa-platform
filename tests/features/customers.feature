Feature: customers

  # Customer creation scenarios covering valid data, missing fields, and duplicate email handling.

  @happy_path @customers
  Scenario: Create Customer with valid data
    Given a unique customer email is generated
    When I create a customer with the generated email and name "Test Customer"
    Then the customer creation response status should be 201
    And the customer should exist in the database with the generated email and name "Test Customer"
    And the customer should appear in the customers list with the generated email

  @edge_case @customers
  Scenario: Create Customer with missing email
    When I attempt to create a customer with name "No Email Customer" but no email
    Then the customer creation response should be a 400 validation error

  @edge_case @customers
  Scenario: Create Customer with missing name
    When I attempt to create a customer with email "noname@example.com" but no name
    Then the customer creation response should be a 400 validation error

  @edge_case @customers
  Scenario: Create Customer with duplicate email
    Given a unique customer email is generated
    And I create a customer with the generated email and name "First Customer"
    When I attempt to create another customer with the same email and name "Second Customer"
    # TODO (unconfirmed): The report does not specify the exact error response for duplicate email. Assuming 409 Conflict or 400 Bad Request.
    Then the duplicate customer creation response should indicate an error

  @happy_path @customers
  Scenario: Update customer information
    Given a customer exists with email "update-test@example.com" and name "Original Name"
    When I update the customer name to "Updated Name"
    Then the customer update response status should be 200
    And the customer in the database should have name "Updated Name"

  @happy_path @customers
  Scenario: Delete customer with no orders
    Given a customer exists with email "delete-no-orders@example.com" and name "Delete Me"
    And the customer has no orders
    When I delete the customer
    Then the customer deletion response status should be 200
    And the customer should no longer exist in the database

  @edge_case @customers
  Scenario: Delete customer with existing orders
    Given a customer exists with email "delete-with-orders@example.com" and name "Has Orders"
    And a product exists with name "Test Product" and price 10.00
    And the customer has an existing order
    When I attempt to delete the customer
    Then the customer deletion response status should be 409
    And the customer deletion error message should indicate they have orders
