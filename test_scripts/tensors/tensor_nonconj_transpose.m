% NonConjugateTranspose (`.'`) — non-conjugate transpose of 2-D tensors.

% Row vector → column vector.
r = [1 2 3 4];
disp(r.');
disp(size(r.'));            % [4 1]

% Column vector → row vector.
c = [10; 20; 30];
disp(c.');
disp(size(c.'));            % [1 3]

% Rectangular matrix: [2 x 3] → [3 x 2].
M = [1 2 3; 4 5 6];
disp(M.');
disp(size(M.'));            % [3 2]

% Square matrix.
S = [1 2; 3 4];
disp(S.');                  % [1 3; 2 4]

% Double transpose is identity.
disp(((M.').'));

% Transpose composed with arithmetic.
A = [1 2; 3 4];
B = A.' + 10;
disp(B);

% Scalar inputs: `.'` is the identity.
x = 7.5;
disp(x.');
