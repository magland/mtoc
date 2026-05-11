% ndims() — minimum reported value is 2 (numbl's padding convention).

disp(ndims(5));            % 2
disp(ndims([1 2 3]));      % 2
disp(ndims([1; 2; 3]));    % 2
disp(ndims([1 2; 3 4]));   % 2
