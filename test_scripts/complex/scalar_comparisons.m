% Scalar complex comparisons.
% Numbl semantics:
%   <  <=  >  >=     compare on the real part only
%   ==  !=           compare both real and imag
% Mixing real and complex on either side exercises the cross-type path.
a = 1 + 2i;
b = 1 - 3i;
c = 2 + 0i;

% Ordering: real part only
disp(a < b);   % 1 == 1 → false → 0
disp(a <= b);  % 1 <= 1 → true → 1
disp(a > c);   % 1 > 2  → false → 0
disp(c >= a);  % 2 >= 1 → true → 1

% Equality: both parts
disp(a == b);  % re same, im differ → 0
disp(a == (1 + 2i));  % both same → 1
disp(a ~= b);  % differ → 1
disp(a ~= (1 + 2i));  % equal → 0

% Mixed real-complex
disp(2 < a);   % 2 < 1 → 0
disp(a < 2);   % 1 < 2 → 1
disp(a == 1);  % im=2 ≠ 0 → 0
disp(c == 2);  % im=0, re==2 → 1
disp(2 == c);  % symmetric → 1
disp(c ~= 2);  % equal → 0
