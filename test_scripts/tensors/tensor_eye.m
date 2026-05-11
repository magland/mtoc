% eye() — square / rectangular identity.

disp(eye());              % 1 (scalar)

I3 = eye(3);
disp(I3);                 % 3x3 identity
disp(size(I3));           % [3 3]

R = eye(3, 5);
disp(R);                  % 3x5 rectangular identity (1s on diagonal)
disp(size(R));            % [3 5]

T = eye(5, 3);
disp(T);                  % 5x3 rectangular identity
disp(size(T));            % [5 3]
